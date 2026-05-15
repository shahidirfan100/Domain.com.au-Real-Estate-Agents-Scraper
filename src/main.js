import { Actor, log } from 'apify';
import { load as cheerioLoad } from 'cheerio';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { firefox } from 'playwright';
import { CookieJar } from 'tough-cookie';

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const DOMAIN_BASE = 'https://www.domain.com.au';
const DEFAULT_AGENT_LOCATION = 'sydney-nsw-2000';

// State capitals with postcodes - Domain.com.au requires suburb-state-postcode format
const STATE_CAPITALS = {
    nsw: 'sydney-nsw-2000',
    vic: 'melbourne-vic-3000',
    qld: 'brisbane-qld-4000',
    wa: 'perth-wa-6000',
    sa: 'adelaide-sa-5000',
    tas: 'hobart-tas-7000',
    act: 'canberra-act-2600',
    nt: 'darwin-nt-0800',
};

const DEFAULT_INPUT_FALLBACK = {
    startUrl: `${DOMAIN_BASE}/real-estate-agents/${DEFAULT_AGENT_LOCATION}/`,
    maxResults: 20,
    maxPages: 3,
    proxyConfiguration: { useApifyProxy: true },
};

// Rotate through multiple realistic user agents
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:127.0) Gecko/20100101 Firefox/127.0',
];

// Timings
const PLAYWRIGHT_NAVIGATION_TIMEOUT_MS = 60000;
const HTTP_REQUEST_TIMEOUT_MS = 30000;
const PLAYWRIGHT_RELOAD_TIMEOUT_MS = 25000;
const DEFAULT_PAGE_SIZE = 15;
const MAX_CARD_PARSE = 160;
const DATASET_BATCH_SIZE = 10;
const PAGE_FETCH_CONCURRENCY = 3;
const FIRST_PAGE_FETCH_ATTEMPTS = 2;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

const randomDelay = (min = 500, max = 1500) => sleep(min + Math.random() * (max - min));

const isProvidedInputValue = (value) => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
};

const mergeWithFallbackInput = (rawInput) => {
    const merged = { ...DEFAULT_INPUT_FALLBACK };
    let providedCount = 0;

    if (rawInput && typeof rawInput === 'object') {
        for (const [key, value] of Object.entries(rawInput)) {
            if (!isProvidedInputValue(value)) continue;
            merged[key] = value;
            providedCount++;
        }
    }

    return { input: merged, usedFallbackInput: providedCount === 0 };
};

const normalizeProxyConfiguration = (proxyConfiguration) => {
    if (!proxyConfiguration?.useApifyProxy) return proxyConfiguration;
    if (proxyConfiguration.proxyUrls?.length) return proxyConfiguration;

    const normalized = { ...proxyConfiguration };
    if (!normalized.groups?.length) {
        normalized.groups = ['RESIDENTIAL'];
    }
    if (!normalized.countryCode) {
        normalized.countryCode = 'AU';
    }
    return normalized;
};

const isProxyConnectionError = (error) => {
    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    return code === 'econnrefused'
        || code === 'econnreset'
        || code === 'etimedout'
        || message.includes('ns_error_proxy_connection_refused')
        || message.includes('proxy_connection_refused')
        || message.includes('tunneling socket could not be established')
        || message.includes('connect econnrefused')
        || (message.includes('proxy') && message.includes('refused'));
};

const isNavigationAbortError = (error) => {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('ns_error_abort')
        || message.includes('ns_binding_aborted')
        || message.includes('err_aborted')
        || message.includes('frame was detached');
};

const cleanText = (text) => {
    if (!text) return null;
    const cleaned = text.replace(/\s+/g, ' ').trim();
    return cleaned.length ? cleaned : null;
};

const ensureAbsoluteUrl = (url) => {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    return `${DOMAIN_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
};

const buildAgentProfileUrl = (value) => {
    if (!value) return null;
    if (value.startsWith('http')) return value;

    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.startsWith('/real-estate-agent/')) return `${DOMAIN_BASE}${normalized}`;
    if (normalized.startsWith('real-estate-agent/')) return `${DOMAIN_BASE}/${normalized}`;

    const slug = normalized.replace(/^\/+|\/+$/g, '');
    return `${DOMAIN_BASE}/real-estate-agent/${slug}/`;
};

const buildAgentLocationUrl = (slug) => `${DOMAIN_BASE}/real-estate-agents/${slug}/`;

const isRootAgentSearchUrl = (url) => {
    try {
        const parsed = new URL(url);
        const normalizedPath = parsed.pathname.replace(/\/+$/, '/');
        return normalizedPath === '/real-estate-agents/';
    } catch {
        return false;
    }
};

const isLikelyAgentUrl = (url) => {
    if (!url) return false;
    const normalized = ensureAbsoluteUrl(url);
    if (!normalized) return false;
    if (normalized === DOMAIN_BASE || normalized === `${DOMAIN_BASE}/`) return false;

    try {
        const parsed = new URL(normalized);
        const lower = parsed.href.toLowerCase();
        if (lower.includes('page=')) return false;

        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length === 0) return false;

        const last = segments[segments.length - 1] || '';
        const baseSegment = segments[0] || '';

        if (baseSegment === 'real-estate-agents' && segments.length === 1) return false;
        if (baseSegment === 'real-estate-agents' && segments.length === 2 && /-(nsw|vic|qld|wa|sa|tas|act|nt)(-\d{4})?$/i.test(last)) {
            return false;
        }

        const looksLikeSlug = last.length > 3 && /[a-z]/i.test(last);
        const hasId = /\d{5,}/.test(last);
        const hasAgentsSegment = segments.includes('real-estate-agents') || segments.includes('real-estate-agent') || segments.includes('agent') || segments.includes('agents');

        return hasAgentsSegment && (looksLikeSlug || hasId);
    } catch {
        return false;
    }
};

const pickAgentHref = (hrefs) => {
    if (!hrefs || hrefs.length === 0) return null;
    const filtered = hrefs.filter((href) => href && !href.startsWith('#'));
    const candidate = filtered.find((href) => {
        const lower = href.toLowerCase();
        if (lower.startsWith('mailto:') || lower.startsWith('tel:')) return false;
        return isLikelyAgentUrl(ensureAbsoluteUrl(href));
    });
    return candidate || filtered[0] || null;
};

const extractPhoneNumber = (text) => {
    if (!text) return null;
    const cleaned = cleanText(text);
    if (!cleaned) return null;
    const phoneMatch = cleaned.match(/(?:\+?61|0)?[2-478](?:[ -]?\d){8}/);
    return phoneMatch ? phoneMatch[0] : null;
};

const extractEmail = (text) => {
    if (!text) return null;
    const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return emailMatch ? emailMatch[0] : null;
};

// ============================================================================
// API FETCH - HTTP only (got-scraping)
// ============================================================================

const isAkamaiChallengePage = (body) => {
    if (!body || typeof body !== 'string') return false;
    const hasChallengeMarkers = body.includes('sec-if-cpt-container')
        || body.includes('Powered and protected by Akamai')
        || body.includes('progress-btn-disabled');
    return hasChallengeMarkers && !body.includes('__NEXT_DATA__');
};

const isAccessDeniedPage = (body) => {
    if (!body || typeof body !== 'string') return false;
    const normalized = body.toLowerCase();
    return normalized.includes('<title>access denied</title>')
        || normalized.includes("you don't have permission to access")
        || normalized.includes('https://errors.edgesuite.net/')
        || normalized.includes('reference #18.');
};

const compactRecord = (value) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length ? trimmed : undefined;
    }
    if (Array.isArray(value)) {
        const cleaned = value
            .map((item) => compactRecord(item))
            .filter((item) => item !== undefined);
        return cleaned.length ? cleaned : undefined;
    }
    if (typeof value === 'object') {
        const output = {};
        for (const [key, nestedValue] of Object.entries(value)) {
            const cleaned = compactRecord(nestedValue);
            if (cleaned !== undefined) output[key] = cleaned;
        }
        return Object.keys(output).length ? output : undefined;
    }
    if (typeof value === 'number' && Number.isNaN(value)) return undefined;
    return value;
};

const compactAgent = (agent) => compactRecord(agent) || {};

class BrowserFallback {
    constructor(proxyConfig, sessionId, userAgent) {
        this.proxyConfig = proxyConfig;
        this.sessionBaseId = sessionId;
        this.sessionNonce = 0;
        this.userAgent = userAgent;
        this.browser = null;
        this.context = null;
    }

    getSessionId() {
        return `${this.sessionBaseId}_${this.sessionNonce}`;
    }

    rotateProxySession() {
        this.sessionNonce += 1;
    }

    async init() {
        if (this.context) return;
        const launchOptions = { headless: true };
        if (this.proxyConfig) {
            const proxyUrl = await this.proxyConfig.newUrl(this.getSessionId());
            if (proxyUrl) {
                const parsed = new URL(proxyUrl);
                launchOptions.proxy = {
                    server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
                    username: parsed.username || undefined,
                    password: parsed.password || undefined,
                };
            }
        }

        this.browser = await firefox.launch(launchOptions);
        this.context = await this.browser.newContext({
            locale: 'en-AU',
            userAgent: this.userAgent,
            extraHTTPHeaders: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
                'Upgrade-Insecure-Requests': '1',
                DNT: '1',
            },
            viewport: { width: 1366, height: 768 },
            ignoreHTTPSErrors: true,
        });

        await this.context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
        });

        await this.context.route('**/*', async (route) => {
            const request = route.request();
            const type = request.resourceType();
            const url = request.url();
            const blockByType = ['image', 'media', 'font'].includes(type);
            const blockByHost = url.includes('googletagmanager')
                || url.includes('google-analytics')
                || url.includes('doubleclick')
                || url.includes('facebook.net')
                || url.includes('hotjar')
                || url.includes('segment.io')
                || url.includes('clarity.ms');

            if (blockByType || blockByHost) {
                await route.abort();
            } else {
                await route.continue();
            }
        });
    }

    async refreshContext({ rotateProxy = false } = {}) {
        if (this.context) await this.context.close().catch(() => {});
        if (this.browser) await this.browser.close().catch(() => {});
        this.context = null;
        this.browser = null;
        if (rotateProxy) this.rotateProxySession();
        await this.init();
    }

    async fetchHtml({ url, referer = DOMAIN_BASE, retries = 3 }) {
        let lastError = null;

        for (let attempt = 1; attempt <= retries; attempt++) {
            await this.init();
            const page = await this.context.newPage();

            try {
                const response = await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: PLAYWRIGHT_NAVIGATION_TIMEOUT_MS,
                });

                const waitForPayload = () => page.waitForFunction(
                    () => {
                        const hasPayload = Boolean(document.querySelector('#__NEXT_DATA__'));
                        const hasAgentLink = Boolean(document.querySelector('a[href^="/real-estate-agent/"]'));
                        return hasPayload || hasAgentLink;
                    },
                    { timeout: 9000 },
                ).catch(() => {});

                await randomDelay(700, 1400);
                await waitForPayload();

                const html = await page.content();
                const statusCode = response?.status() || 0;
                const title = await page.title().catch(() => '');
                const hasStructuredPayload = html.includes('__NEXT_DATA__') || html.includes('ContactSearchContact:');
                const hasAgentLinks = html.includes('/real-estate-agent/');
                const accessDenied = isAccessDeniedPage(html);

                if (accessDenied) {
                    await Actor.setValue('DEBUG_LAST_FETCH_FAILURE', {
                        url,
                        referer,
                        attempt,
                        statusCode,
                        title,
                        hasStructuredPayload,
                        hasAgentLinks,
                        htmlSnippet: html.slice(0, 4000),
                    });
                    throw new Error(`Browser blocked by access denied page (status=${statusCode})`);
                }

                if (statusCode >= 400 || isAkamaiChallengePage(html) || (!hasStructuredPayload && !hasAgentLinks)) {
                    await randomDelay(2000, 3500);
                    await page.reload({
                        waitUntil: 'domcontentloaded',
                        timeout: PLAYWRIGHT_RELOAD_TIMEOUT_MS,
                    }).catch(() => {});
                    await waitForPayload();

                    const retryHtml = await page.content();
                    const retryTitle = await page.title().catch(() => title);
                    const hasRetryPayload = retryHtml.includes('__NEXT_DATA__') || retryHtml.includes('ContactSearchContact:');
                    const hasRetryAgentLinks = retryHtml.includes('/real-estate-agent/');
                    if (!isAkamaiChallengePage(retryHtml) && !isAccessDeniedPage(retryHtml) && (hasRetryPayload || hasRetryAgentLinks)) {
                        await page.close().catch(() => {});
                        return { html: retryHtml, statusCode, source: 'playwright-firefox-reload' };
                    }

                    await Actor.setValue('DEBUG_LAST_FETCH_FAILURE', {
                        url,
                        referer,
                        attempt,
                        statusCode,
                        title: retryTitle,
                        hasStructuredPayload: hasRetryPayload,
                        hasAgentLinks: hasRetryAgentLinks,
                        htmlSnippet: retryHtml.slice(0, 4000),
                    });

                    throw new Error(`Browser fetch did not return usable payload (status=${statusCode})`);
                }

                await page.close().catch(() => {});
                return { html, statusCode, source: 'playwright-firefox' };
            } catch (error) {
                lastError = error;
                await page.close().catch(() => {});
                if (attempt < retries) {
                    const rotateProxy = isProxyConnectionError(error) || isNavigationAbortError(error);
                    if (rotateProxy) {
                        log.warning(`Browser fallback rotating proxy session after network/proxy failure: ${error.message}`);
                    }
                    await this.refreshContext({ rotateProxy });
                    await randomDelay(500, 1200);
                }
            }
        }

        throw lastError || new Error('Browser fetch failed');
    }

    async close() {
        if (this.context) await this.context.close().catch(() => {});
        if (this.browser) await this.browser.close().catch(() => {});
        this.context = null;
        this.browser = null;
    }
}

function createPageFetcher(proxyConfig) {
    const sessionId = `domain_${Date.now()}`;
    const userAgent = getRandomUserAgent();
    const cookieJar = new CookieJar();
    const browserFallback = new BrowserFallback(proxyConfig, sessionId, userAgent);
    let proxySessionNonce = 0;
    let warmedUpSessionId = null;
    let warmedUp = false;

    const getSessionId = () => `${sessionId}_${proxySessionNonce}`;

    const rotateProxySession = () => {
        proxySessionNonce += 1;
        warmedUp = false;
        warmedUpSessionId = null;
    };

    const getProxyUrl = async () => {
        if (!proxyConfig) return undefined;
        return proxyConfig.newUrl(getSessionId());
    };

    const fetchViaHttp = async ({ url, referer = DOMAIN_BASE, retries = 2 }) => {
        let lastError = null;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const proxyUrl = await getProxyUrl();
                const currentSessionId = getSessionId();

                if (!warmedUp || warmedUpSessionId !== currentSessionId) {
                    await gotScraping.get(DOMAIN_BASE, {
                        proxyUrl,
                        cookieJar,
                        throwHttpErrors: false,
                        timeout: { request: HTTP_REQUEST_TIMEOUT_MS },
                        headers: {
                            'user-agent': userAgent,
                            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            'accept-language': 'en-AU,en-US;q=0.9,en;q=0.8',
                            'upgrade-insecure-requests': '1',
                            dnt: '1',
                        },
                    });
                    warmedUp = true;
                    warmedUpSessionId = currentSessionId;
                }

                const response = await gotScraping.get(url, {
                    proxyUrl,
                    cookieJar,
                    throwHttpErrors: false,
                    timeout: { request: HTTP_REQUEST_TIMEOUT_MS },
                    headers: {
                        'user-agent': userAgent,
                        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'accept-language': 'en-AU,en-US;q=0.9,en;q=0.8',
                        'upgrade-insecure-requests': '1',
                        dnt: '1',
                        referer,
                    },
                });

                const html = response.body || '';
                const statusCode = response.statusCode || 0;
                const hasStructuredPayload = html.includes('__NEXT_DATA__') || html.includes('ContactSearchContact:');
                const hasAgentLinks = html.includes('/real-estate-agent/');
                const accessDenied = isAccessDeniedPage(html);

                if (statusCode < 400 && !isAkamaiChallengePage(html) && !accessDenied && (hasStructuredPayload || hasAgentLinks)) {
                    return { html, statusCode, source: 'http-got' };
                }

                lastError = new Error(`HTTP fetch did not return usable payload (status=${statusCode})`);
                if ([403, 407, 429, 502, 503, 504].includes(statusCode) || accessDenied || isAkamaiChallengePage(html)) {
                    rotateProxySession();
                }
                await randomDelay(250, 700);
            } catch (error) {
                lastError = error;
                if (isProxyConnectionError(error)) {
                    log.warning(`HTTP fetch rotating proxy session after network/proxy failure: ${error.message}`);
                    rotateProxySession();
                }
                await randomDelay(250, 700);
            }
        }

        throw lastError || new Error('HTTP fetch failed');
    };

    const fetchHtml = async ({ url, referer = DOMAIN_BASE, retries = 2 }) => {
        try {
            return await fetchViaHttp({ url, referer, retries });
        } catch (httpError) {
            log.debug(`HTTP fetch fallback triggered for ${url}: ${httpError.message}`);
            return browserFallback.fetchHtml({
                url,
                referer,
                retries: 2,
            });
        }
    };

    const close = async () => {
        await browserFallback.close();
    };

    return { fetchHtml, close };
}

// ============================================================================
// MULTI-TIER DATA EXTRACTION
// ============================================================================

const extractNextData = (html) => {
    try {
        const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
        if (match?.[1]) {
            return JSON.parse(match[1]);
        }
    } catch {
        // Invalid JSON
    }
    return null;
};

const extractApolloState = (html) => {
    const patterns = [
        /window\.__APOLLO_STATE__\s*=\s*({.*?})(?:\s*;|\s*<\/script>)/s,
        /window\.__INITIAL_STATE__\s*=\s*({.*?})(?:\s*;|\s*<\/script>)/s,
        /window\.__INITIAL_DATA__\s*=\s*({.*?})(?:\s*;|\s*<\/script>)/s,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) {
            try {
                return JSON.parse(match[1]);
            } catch {
                // Invalid JSON
            }
        }
    }
    return null;
};

const extractJsonLd = (html) => {
    const $ = cheerioLoad(html);
    const scripts = $('script[type="application/ld+json"]');
    const jsonLdData = [];

    scripts.toArray().forEach((script) => {
        try {
            const content = $(script).html();
            if (content) {
                const data = JSON.parse(content);
                if (Array.isArray(data)) {
                    jsonLdData.push(...data);
                } else {
                    jsonLdData.push(data);
                }
            }
        } catch {
            // Invalid JSON-LD
        }
    });

    return jsonLdData;
};

const parseJsonLdAgent = (jsonLd) => {
    const agent = {};

    for (const data of jsonLd) {
        const type = data['@type'];
        if (type === 'Person' || type === 'RealEstateAgent' || type === 'Employee') {
            agent.name = data.name || agent.name;
            agent.email = data.email || agent.email;
            agent.phone = data.telephone || data.phone || agent.phone;
            agent.title = data.jobTitle || data.title || agent.title;

            if (data.image) {
                agent.profileImage = typeof data.image === 'string' ? data.image : data.image.url;
            }

            if (data.address) {
                agent.officeAddress = data.address.streetAddress || agent.officeAddress;
                agent.suburb = data.address.addressLocality || agent.suburb;
                agent.state = data.address.addressRegion || agent.state;
                agent.postcode = data.address.postalCode || agent.postcode;
            }

            if (data.worksFor) {
                agent.agency = data.worksFor.name || agent.agency;
                agent.agencyUrl = data.worksFor.url || agent.agencyUrl;
            }

            if (data.description) {
                agent.biography = data.description;
            }
        }
    }

    return Object.keys(agent).length > 0 ? agent : null;
};

// ============================================================================
// AGENT DATA NORMALIZATION
// ============================================================================

const isAgentLike = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    return Boolean(
        obj.agentId ||
        obj.agentName ||
        obj.firstName ||
        obj.lastName ||
        obj.name ||
        obj.fullName ||
        obj.displayName ||
        obj.email ||
        obj.phone ||
        obj.profileUrl ||
        obj.profilePageUrl ||
        obj.profileSlug ||
        obj.slug ||
        obj.agencyName
    );
};

const locateAgentArray = (payload) => {
    const visited = new Set();
    const queue = [payload];
    let best = [];

    while (queue.length) {
        const current = queue.shift();
        if (!current) continue;
        if (typeof current === 'object') {
            if (visited.has(current)) continue;
            visited.add(current);
        }

        if (Array.isArray(current)) {
            const agentCandidates = current.filter(isAgentLike);
            if (agentCandidates.length > best.length) best = agentCandidates;
        }

        if (current && typeof current === 'object') {
            for (const value of Object.values(current)) {
                if (value && (typeof value === 'object' || Array.isArray(value))) {
                    queue.push(value);
                }
            }
        }
    }

    return best;
};

const normalizeAgentFromJson = (rawAgent) => {
    const agentData = rawAgent?.agent || rawAgent;
    if (!agentData || typeof agentData !== 'object') return null;

    const contact = agentData.contact || agentData.contactDetails || {};
    const agency = agentData.agency || agentData.agencyDetails || {};
    const profile = agentData.profile || agentData.profileDetails || {};
    const performance = agentData.performance || agentData.stats || {};

    const urlCandidate =
        agentData.url ||
        buildAgentProfileUrl(agentData.profileUrl) ||
        agentData.profilePageUrl ||
        agentData.profileSlug ||
        agentData.slug ||
        agentData.canonicalUrl ||
        (agentData.agentSlug ? ensureAbsoluteUrl(agentData.agentSlug) : null);
    const normalizedUrl = ensureAbsoluteUrl(urlCandidate);

    const agent = {
        id: String(agentData.id || agentData.agentId || agentData.profileId || '') || null,
        url: isLikelyAgentUrl(normalizedUrl) ? normalizedUrl : null,
        name: agentData.name || agentData.fullName || agentData.displayName || agentData.agentName ||
            (agentData.firstName && agentData.lastName ? `${agentData.firstName} ${agentData.lastName}` : null),
        firstName: agentData.firstName || agentData.givenName || null,
        lastName: agentData.lastName || agentData.familyName || null,
        title: agentData.title || agentData.jobTitle || agentData.position || agentData.role || null,
        agency: agency.name || agentData.agencyName || agentData.officeName || null,
        agencyUrl: ensureAbsoluteUrl(agency.url || agentData.agencyUrl || agentData.officeUrl) || null,
        phone: contact.phone || contact.phoneNumber || agentData.phone || agentData.phoneNumber || null,
        mobile: contact.mobile || contact.mobileNumber || agentData.mobile || agentData.mobileNumber || null,
        email: contact.email || contact.emailAddress || agentData.email || null,
        officeAddress: contact.address || agency.address || agentData.officeAddress || null,
        suburb: contact.suburb || agency.suburb || agentData.suburb || agentData.location?.suburb || null,
        state: contact.state || agency.state || agentData.state || agentData.location?.state || null,
        postcode: contact.postcode || agency.postcode || agentData.postcode || null,
        profileImage: agentData.profileImage || agentData.image || agentData.photo || agentData.photoUrl || agentData.avatar || null,
        agencyLogo: agency.logo || agentData.agencyLogo || null,
        biography: profile.biography || agentData.biography || agentData.bio || agentData.description || null,
        specializations: agentData.specializations || agentData.specialties || null,
        languages: agentData.languages || null,
        currentListings: performance.currentListings || agentData.currentListings || null,
        soldProperties: performance.soldProperties || agentData.soldProperties || null,
        rentedProperties: performance.rentedProperties || agentData.rentedProperties || null,
        rating: agentData.rating || agentData.averageRating || null,
        reviewCount: agentData.reviewCount || agentData.numberOfReviews || null,
        source: DOMAIN_BASE,
        scrapedAt: new Date().toISOString(),
    };

    if (!agent.id && agent.url) {
        const idMatch = agent.url.match(/(\d{6,})(?:[/?#]|$)/);
        if (idMatch) agent.id = idMatch[1];
    }

    return agent.url || agent.name ? agent : null;
};

function addMetadata(agent) {
    if (!agent) return agent;
    return {
        ...agent,
        scrapedAt: agent.scrapedAt || new Date().toISOString(),
        source: agent.source || DOMAIN_BASE,
    };
}

const getApolloRef = (value) => value?.__ref || null; // eslint-disable-line no-underscore-dangle

const getApolloStateFromPageProps = (pageProps) => pageProps?.__APOLLO_STATE__ || null; // eslint-disable-line no-underscore-dangle

// ============================================================================
// MULTI-TIER EXTRACTION FROM HTML
// ============================================================================
/**
 * Extract agents from Apollo State (ContactSearchContact entries)
 * Based on actual page structure: __NEXT_DATA__.props.pageProps.__APOLLO_STATE__
 * Agent keys follow pattern: ContactSearchContact:<ID>
 * 
 * Field mappings based on inspection:
 * - rating: reputation.overallStarRating
 * - reviewCount: reputation.numberOfReviews
 * - propertiesForSale: totalForSale
 * - propertiesForRent: totalForRent
 * - propertiesSold: totalSoldAndAuctioned
 */
const extractAgentsFromApolloState = (apolloState) => {
    if (!apolloState || typeof apolloState !== 'object') {
        return { agents: [], totalResults: null, totalPages: null, pageNumber: null };
    }

    const rootQuery = apolloState.ROOT_QUERY || {};
    const contactSearchKeys = Object.keys(rootQuery).filter((key) => key.startsWith('contactSearchBySuburbs('));

    if (!contactSearchKeys.length) {
        return { agents: [], totalResults: null, totalPages: null, pageNumber: null };
    }

    const selectedKey = contactSearchKeys
        .map((key) => ({ key, entry: rootQuery[key] }))
        .sort((left, right) => (right.entry?.total || 0) - (left.entry?.total || 0))[0];
    const searchEntry = selectedKey?.entry;
    const resultRefs = Array.isArray(searchEntry?.results) ? searchEntry.results : [];
    const agents = [];

    log.debug(`Found ${resultRefs.length} structured agent refs in ${selectedKey?.key}`);

    for (const ref of resultRefs) {
        try {
            const contactRef = getApolloRef(ref);
            const contact = contactRef ? apolloState[contactRef] : ref;
            if (!contact || typeof contact !== 'object') continue;

            const reputationRef = getApolloRef(contact.reputation);
            const reputation = reputationRef
                ? (apolloState[reputationRef] || {})
                : (contact.reputation || {});

            let firstName = null;
            let lastName = null;
            if (contact.name) {
                const nameParts = contact.name.trim().split(/\s+/);
                firstName = nameParts[0] || null;
                lastName = nameParts.slice(1).join(' ').trim() || null;
            }

            const agent = {
                id: String(contact.id || contact.agentIdV2 || '') || null,
                agentIdV2: contact.agentIdV2 || null,
                agencyId: contact.agencyId ?? null,
                url: buildAgentProfileUrl(contact.profileUrl),
                profileSlug: contact.profileUrl || null,
                name: contact.name || null,
                firstName,
                lastName,
                title: contact.jobTitle || null,
                agency: contact.agencyName || null,
                agencyUrl: contact.agencyProfileUrl ? ensureAbsoluteUrl(contact.agencyProfileUrl) : null,
                phone: contact.telephone || contact.phone || null,
                mobile: contact.mobile || null,
                hasEmail: Boolean(contact.hasEmail),
                profileTier: contact.profileTier || null,
                profileImage: contact.profilePhoto || contact.profilePhotoUrl || contact.photo || null,
                agencyLogo: contact.agencyLogoUrl || contact.agencyLogo || null,
                brandColour: contact.brandColour || null,
                averageSoldPrice: contact.averageSoldPrice ?? null,
                averageSoldDaysOnMarket: contact.averageSoldDaysOnMarket ?? null,
                propertiesForSale: contact.totalForSale ?? contact.propertiesForSale ?? null,
                propertiesForRent: contact.totalForRent ?? contact.propertiesForRent ?? null,
                propertiesSold: contact.totalSoldAndAuctioned ?? contact.propertiesSold ?? null,
                totalSoldAndAuctioned: contact.totalSoldAndAuctioned ?? null,
                totalJointSoldAndAuctioned: contact.totalJointSoldAndAuctioned ?? null,
                totalLeased: contact.totalLeased ?? null,
                totalJointLeased: contact.totalJointLeased ?? null,
                rating: reputation.overallStarRating ?? reputation.starRating ?? contact.rating ?? null,
                reviewCount: reputation.numberOfReviews ?? reputation.reviewCount ?? contact.reviewCount ?? null,
                recentRating: reputation.overallStarRatingRecent ?? null,
                recentReviewCount: reputation.numberOfReviewsRecent ?? null,
                source: DOMAIN_BASE,
                scrapedAt: new Date().toISOString(),
            };

            if (agent.name || agent.url) {
                agents.push(agent);
            }
        } catch (err) {
            log.debug(`Failed to parse structured contact ref: ${err.message}`);
        }
    }

    return {
        agents,
        totalResults: searchEntry?.total ?? null,
        totalPages: searchEntry?.totalPages ?? null,
        pageNumber: searchEntry?.pageNumber ?? null,
    };
};


const extractAgentsMultiTier = (html, sourceUrl, currentPage) => {
    let agents = [];
    let totalResults = null;
    let nextPage = null;
    let extractionMethod = 'none';

    // Tier 1: __NEXT_DATA__ with __APOLLO_STATE__ (MOST RELIABLE)
    const nextData = extractNextData(html);
    if (nextData) {
        const pageProps = nextData.props?.pageProps;

        // Check for Apollo State inside NEXT_DATA
        const apolloState = getApolloStateFromPageProps(pageProps);
        if (apolloState) {
            const structured = extractAgentsFromApolloState(apolloState);
            agents = structured.agents;
            if (agents.length > 0) {
                extractionMethod = 'structured';
                log.info(`Extracted ${agents.length} agents from structured payload`);
                totalResults = structured.totalResults;
                if (structured.totalPages && structured.pageNumber && structured.pageNumber < structured.totalPages) {
                    nextPage = deriveNextPageUrl(sourceUrl, structured.pageNumber);
                }
            }
        }

        // Fallback: Try to find agents array directly in pageProps
        if (agents.length === 0 && pageProps) {
            const agentArray = locateAgentArray(pageProps);
            if (agentArray.length > 0) {
                agents = agentArray
                    .map((item) => normalizeAgentFromJson(item))
                    .filter((item) => item && (item.url || item.name));
                extractionMethod = 'structured';
                log.info(`Extracted ${agents.length} agents from structured payload`);

                totalResults = pageProps.totalAgents || pageProps.total || pageProps.pagination?.total || null;
            }
        }
    }

    // Tier 2: Standalone Apollo/Initial State (window.__APOLLO_STATE__)
    if (agents.length === 0) {
        const apolloState = extractApolloState(html);
        if (apolloState) {
            const structured = extractAgentsFromApolloState(apolloState);
            agents = structured.agents;
            if (agents.length > 0) {
                extractionMethod = 'structured';
                log.info(`Extracted ${agents.length} agents from structured payload`);
                totalResults = structured.totalResults;
                if (structured.totalPages && structured.pageNumber && structured.pageNumber < structured.totalPages) {
                    nextPage = deriveNextPageUrl(sourceUrl, structured.pageNumber);
                }
            }

            // Fallback to generic search
            if (agents.length === 0) {
                const agentArray = locateAgentArray(apolloState);
                if (agentArray.length > 0) {
                    agents = agentArray
                        .map((item) => normalizeAgentFromJson(item))
                        .filter((item) => item && (item.url || item.name));
                    extractionMethod = 'structured';
                    log.info(`Extracted ${agents.length} agents from structured payload`);
                }
            }
        }
    }

    // Tier 3: JSON-LD
    if (agents.length === 0) {
        const jsonLd = extractJsonLd(html);
        if (jsonLd.length > 0) {
            const parsed = parseJsonLdAgent(jsonLd);
            if (parsed) {
                agents = [addMetadata(parsed)];
                extractionMethod = 'JSON-LD';
                log.info(`Extracted ${agents.length} agents from JSON-LD`);
            }
        }
    }

    // Tier 4: HTML Parsing (FALLBACK)
    if (agents.length === 0) {
        const htmlResult = parseAgentsFromHtml(html);
        agents = htmlResult.agents;
        totalResults = htmlResult.totalResults || totalResults;
        nextPage = htmlResult.nextPage;
        extractionMethod = 'HTML Parsing';
        log.info(`Extracted ${agents.length} agents from HTML parsing`);
    }

    // Derive next page if not found
    if (!nextPage && agents.length > 0) {
        nextPage = deriveNextPageUrl(sourceUrl, currentPage);
    }

    return { agents: agents.map(addMetadata), totalResults, nextPage, extractionMethod };
};

function parseAgentsFromHtml(html) {
    const $ = cheerioLoad(html);
    const agents = [];
    let totalResults = null;

    // Multiple selector strategies based on actual page inspection
    let agentCards = [];

    // Strategy 1: Find containers with profile links to /real-estate-agent/
    // Based on inspection: cards contain <a href="/real-estate-agent/...">
    const profileLinks = $('a[href^="/real-estate-agent/"]').toArray();
    log.debug(`Found ${profileLinks.length} profile links`);

    // Get parent containers for each profile link
    const cardContainers = new Set();
    for (const link of profileLinks) {
        let container = $(link).parent();
        // Go up until we find a container with meaningful content (h3, stats, etc.)
        for (let i = 0; i < 5 && container.length; i++) {
            if (container.find('h3').length > 0 || container.find('dl').length > 0) {
                cardContainers.add(container[0]);
                break;
            }
            container = container.parent();
        }
    }
    agentCards = Array.from(cardContainers);
    log.debug(`Found ${agentCards.length} agent card containers via profile links`);

    // Strategy 2: Direct class selectors from inspection
    if (agentCards.length === 0) {
        agentCards = $('div.css-14ap5d, div[class*="agent-card"]').toArray();
        log.debug(`Found ${agentCards.length} agent cards via class selectors`);
    }

    // Strategy 3: data-testid patterns
    if (agentCards.length === 0) {
        agentCards = $(
            '[data-testid*="agent-card"], [data-testid*="agent-tile"], [data-testid*="agent-list-item"]'
        ).toArray();
        log.debug(`Found ${agentCards.length} agent cards via data-testid`);
    }

    // Strategy 4: Class-based fallback
    if (agentCards.length === 0) {
        agentCards = $(
            'article.agent-card, article[class*="agent"], div[class*="agent-profile"], li[class*="agent"]'
        ).toArray();
        log.debug(`Found ${agentCards.length} agent cards via article/class selectors`);
    }

    if (agentCards.length > MAX_CARD_PARSE) {
        agentCards = agentCards.slice(0, MAX_CARD_PARSE);
    }


    for (const card of agentCards) {
        try {
            const $card = $(card);

            // Find profile link - primary method for agent URL
            const profileLink = $card.find('a[href^="/real-estate-agent/"]').first();
            let agentUrl = profileLink.attr('href');

            if (!agentUrl) {
                const hrefs = $card
                    .find('a[href]')
                    .map((_, el) => $(el).attr('href'))
                    .get();
                agentUrl = pickAgentHref(hrefs);
            }

            agentUrl = ensureAbsoluteUrl(agentUrl);

            if (!agentUrl || !agentUrl.includes('/real-estate-agent/')) {
                continue;
            }

            // Extract agent name - h3 is the primary name element
            let nameText = cleanText($card.find('h3').first().text());
            if (!nameText) {
                nameText = cleanText($card.find('h3.css-1hakis5').first().text());
            }
            if (!nameText) {
                nameText = cleanText(profileLink.text());
            }
            if (!nameText || /find agents?/i.test(nameText) || /view profile/i.test(nameText)) continue;

            // Extract job title (usually first p after h3)
            const allParagraphs = $card.find('p').toArray();
            let titleText = null;
            let agencyText = null;

            if (allParagraphs.length >= 1) {
                titleText = cleanText($(allParagraphs[0]).text());
            }
            if (allParagraphs.length >= 2) {
                agencyText = cleanText($(allParagraphs[1]).text());
            }

            // Extract stats from dl element
            let avgSoldPrice = null;
            let propertiesSold = null;
            const statsContainer = $card.find('dl').first();
            if (statsContainer.length) {
                statsContainer.find('div').each((_, statDiv) => {
                    const label = cleanText($(statDiv).find('dt').text())?.toLowerCase() || '';
                    const value = cleanText($(statDiv).find('dd').text());

                    if (label.includes('sold price') || label.includes('avg sold')) {
                        avgSoldPrice = value;
                    } else if (label.includes('properties sold') || label.includes('sold')) {
                        propertiesSold = value;
                    }
                });
            }

            // Extract agent ID from URL
            const idMatch = agentUrl.match(/-(\d{6,})\/?$/);
            const agentId = idMatch ? idMatch[1] : null;

            const agent = {
                id: agentId,
                url: agentUrl,
                name: nameText,
                title: titleText,
                agency: agencyText,
                agencyUrl: ensureAbsoluteUrl($card.find('a[href*="/real-estate-agencies/"]').first().attr('href')) || null,
                phone: extractPhoneNumber(
                    $card.find('a[href^="tel:"], button[data-testid="cta-call-button"]').first().text() ||
                    $card.find('a[href^="tel:"]').attr('href') ||
                    ''
                ),
                email: extractEmail(
                    $card.find('a[href^="mailto:"], button[data-testid="contact__email-button"]').first().text() ||
                    $card.find('a[href^="mailto:"]').attr('href') ||
                    ''
                ),
                profileImage: $card.find('img[data-testid="fe-co-avatar--image"], img[alt*="agent"], img[alt*="Agent"]').first().attr('src') || null,
                agencyLogo: $card.find('img[data-testid*="agency"], img[alt*="logo"], img[alt*="Logo"]').first().attr('src') || null,
                averageSoldPrice: avgSoldPrice,
                propertiesSold,
                source: DOMAIN_BASE,
                scrapedAt: new Date().toISOString(),
            };

            agents.push(agent);
        } catch (err) {
            log.debug(`Failed to parse agent card: ${err.message}`);
        }
    }

    log.debug(`Parsed ${agents.length} agents from HTML cards`);

    // Extract pagination - based on inspection
    let nextPageLink = $('a[href*="page="]').filter((_, el) => {
        const text = $(el).text().toLowerCase();
        return text.includes('next') || text === '›' || text === '»';
    }).first().attr('href');

    if (!nextPageLink) {
        nextPageLink = $('nav[aria-label="pagination"] a').filter((_, el) => {
            const text = $(el).text().toLowerCase();
            return text.includes('next');
        }).first().attr('href');
    }
    if (!nextPageLink) nextPageLink = $('a[aria-label="Go to next page"]').attr('href');
    if (!nextPageLink) nextPageLink = $('a[rel="next"]').attr('href');

    // Try to find total from page header (e.g., "1,234 real estate agents")
    const headerText = $('h1').first().text();
    const totalMatch = headerText?.match(/([\d,]+)\s*real estate agents?/i);
    if (totalMatch) totalResults = parseInt(totalMatch[1].replace(/,/g, ''), 10);

    return { agents, totalResults, nextPage: ensureAbsoluteUrl(nextPageLink) };
}

function deriveNextPageUrl(url, currentPage) {
    try {
        const parsed = new URL(url);
        const current = currentPage || parseInt(parsed.searchParams.get('page') || '1', 10) || 1;
        parsed.searchParams.set('page', current + 1);
        if (!parsed.searchParams.get('pageSize')) parsed.searchParams.set('pageSize', String(DEFAULT_PAGE_SIZE));
        return parsed.toString();
    } catch (err) {
        log.debug(`Could not derive next page: ${err.message}`);
        return null;
    }
}

// ============================================================================
// HELPER: Dataset Pusher
// ============================================================================

function createDatasetPusher(batchSize) {
    const size = Math.max(1, batchSize || DATASET_BATCH_SIZE);
    const buffer = [];
    let chain = Promise.resolve();

    const enqueue = (items) => {
        const list = Array.isArray(items) ? items : [items];
        if (!list.length) return;

        chain = chain.then(async () => {
            buffer.push(...list);
            while (buffer.length >= size) {
                const batch = buffer.splice(0, size);
                await Dataset.pushData(batch);
            }
        });
    };

    const flush = async () => {
        await chain;
        while (buffer.length) {
            const batch = buffer.splice(0, size);
            await Dataset.pushData(batch);
        }
    };

    return { enqueue, flush };
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    const worker = async () => {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex++;
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    };

    const workerCount = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

const computeTargetPageCount = ({ maxResults, maxPages, totalResults, firstPageCount }) => {
    const perPage = Math.max(1, firstPageCount || DEFAULT_PAGE_SIZE);
    const pageCountForResults = Math.ceil(maxResults / perPage);
    const pageCountForTotal = totalResults ? Math.ceil(totalResults / perPage) : maxPages;
    return Math.max(1, Math.min(maxPages, pageCountForResults, pageCountForTotal));
};

const buildSearchUrl = ({ startUrl, state, specialization, startUrlProvided }) => {
    let baseUrl = startUrl;

    if (state && (!startUrlProvided || isRootAgentSearchUrl(startUrl))) {
        const stateKey = String(state).toLowerCase().trim();
        const locationSlug = STATE_CAPITALS[stateKey] || DEFAULT_AGENT_LOCATION;
        baseUrl = buildAgentLocationUrl(locationSlug);
        log.info(`Using state capital for ${stateKey.toUpperCase()}: ${locationSlug}`);
    } else if (state && startUrlProvided) {
        log.info('Ignoring state filter because an explicit startUrl was provided');
    }

    const parsed = new URL(baseUrl);
    if (!parsed.hostname.includes('domain.com.au')) {
        throw new Error('Invalid input: startUrl must be from domain.com.au');
    }

    if (specialization) parsed.searchParams.set('specialization', String(specialization));

    return parsed.toString();
};

const getFetchCandidates = (url) => {
    const candidates = [url];
    try {
        const parsed = new URL(url);
        const hasPageParam = parsed.searchParams.has('page') || parsed.searchParams.has('pageSize');
        if (hasPageParam) {
            parsed.searchParams.delete('page');
            parsed.searchParams.delete('pageSize');
            candidates.push(parsed.toString());
        }
    } catch {
        // Ignore malformed URL fallback generation
    }

    return [...new Set(candidates)];
};

const fetchFirstPageWithRecovery = async ({ pageFetcher, searchUrl }) => {
    const candidates = getFetchCandidates(searchUrl);
    const attempts = [];

    for (let attempt = 1; attempt <= FIRST_PAGE_FETCH_ATTEMPTS; attempt++) {
        for (const candidateUrl of candidates) {
            try {
                const fetched = await pageFetcher.fetchHtml({
                    url: candidateUrl,
                    referer: DOMAIN_BASE,
                    retries: 2,
                });
                return { fetched, resolvedUrl: candidateUrl, attempts };
            } catch (error) {
                const message = error?.message || String(error);
                attempts.push({ attempt, url: candidateUrl, error: message });
                log.warning(`First-page fetch attempt ${attempt} failed for ${candidateUrl}: ${message}`);
                await randomDelay(250, 700);
            }
        }
    }

    const errorSummary = attempts
        .slice(-4)
        .map((item) => `attempt ${item.attempt} ${item.url} -> ${item.error}`)
        .join(' | ');
    throw new Error(`Unable to fetch first page after ${attempts.length} attempts. Last errors: ${errorSummary}`);
};

// ============================================================================
// MAIN ACTOR LOGIC
// ============================================================================

Actor.main(async () => {
    const rawInput = (await Actor.getInput()) || {};
    const { input, usedFallbackInput } = mergeWithFallbackInput(rawInput);
    const startUrlProvided = isProvidedInputValue(rawInput.startUrl);

    const {
        startUrl,
        maxResults,
        maxPages,
        proxyConfiguration,
        state = null,
        specialization = null,
    } = input;

    const normalizedProxyConfiguration = normalizeProxyConfiguration(proxyConfiguration);
    if (normalizedProxyConfiguration?.useApifyProxy) {
        log.info('Using Apify proxy configuration', {
            groups: normalizedProxyConfiguration.groups || [],
            countryCode: normalizedProxyConfiguration.countryCode || null,
        });
    }

    const proxyConfig = normalizedProxyConfiguration
        ? await Actor.createProxyConfiguration(normalizedProxyConfiguration)
        : null;
    const validatedMaxResults = Math.max(1, Math.min(maxResults || 20, 1000));
    const validatedMaxPages = Math.max(1, Math.min(maxPages || 3, 50));

    let searchUrl = buildSearchUrl({ startUrl, state, specialization, startUrlProvided });
    if (isRootAgentSearchUrl(searchUrl)) {
        searchUrl = buildAgentLocationUrl(DEFAULT_AGENT_LOCATION);
        log.warning(`Root search URL detected. Using default location: ${DEFAULT_AGENT_LOCATION}`);
    }

    log.info('Domain.com.au Real Estate Agents Scraper started', {
        startUrl,
        searchUrl,
        maxResults: validatedMaxResults,
        maxPages: validatedMaxPages,
        usedFallbackInput,
    });

    const allAgents = [];
    const seenIds = new Set();
    const datasetPusher = createDatasetPusher(DATASET_BATCH_SIZE);
    const pageFetcher = createPageFetcher(proxyConfig);

    let pagesProcessed = 0;
    let httpPagesUsed = 0;
    let browserPagesUsed = 0;
    let totalResultsCount = null;

    const addAgentsToDataset = (agents, pageNumber) => {
        let addedThisPage = 0;
        const newItemsThisPage = [];

        for (const agent of agents) {
            const dedupeKey = agent.id || agent.url || agent.name;
            if (!dedupeKey || seenIds.has(dedupeKey)) continue;

            seenIds.add(dedupeKey);
            const normalized = compactAgent(addMetadata(agent));
            allAgents.push(normalized);
            newItemsThisPage.push({ ...normalized });
            addedThisPage++;

            if (allAgents.length >= validatedMaxResults) break;
        }

        if (newItemsThisPage.length) {
            datasetPusher.enqueue(newItemsThisPage);
        }

        log.info(`Added ${addedThisPage} unique agents (${allAgents.length}/${validatedMaxResults} total)`, {
            page: pageNumber,
        });
    };

    try {
        log.info(`Page 1/${validatedMaxPages} - Collected: 0/${validatedMaxResults}`, {
            url: searchUrl,
        });

        const firstPage = await fetchFirstPageWithRecovery({ pageFetcher, searchUrl });
        const firstFetch = firstPage.fetched;
        if (firstPage.resolvedUrl !== searchUrl) {
            log.info('Using auto-healed first-page URL variant', {
                originalUrl: searchUrl,
                resolvedUrl: firstPage.resolvedUrl,
            });
            searchUrl = firstPage.resolvedUrl;
        }

        if (firstFetch.source.startsWith('http')) {
            httpPagesUsed++;
        } else {
            browserPagesUsed++;
        }

        const firstResult = extractAgentsMultiTier(firstFetch.html, searchUrl, 1);
        if (!firstResult || firstResult.agents.length === 0) {
            throw new Error('No agents found on page 1');
        }

        pagesProcessed++;
        log.info(`Found ${firstResult.agents.length} agents on page 1`, {
            source: firstFetch.source,
        });

        if (firstResult.totalResults) {
            totalResultsCount = firstResult.totalResults;
            log.info(`Total available: ${totalResultsCount} agents`);
        }

        addAgentsToDataset(firstResult.agents, 1);

        const targetPageCount = computeTargetPageCount({
            maxResults: validatedMaxResults,
            maxPages: validatedMaxPages,
            totalResults: totalResultsCount,
            firstPageCount: firstResult.agents.length,
        });

        const pageJobs = [];
        let nextPageUrl = firstResult.nextPage || deriveNextPageUrl(searchUrl, 1);
        for (let pageNumber = 2; pageNumber <= targetPageCount && nextPageUrl; pageNumber++) {
            pageJobs.push({ pageNumber, url: nextPageUrl });
            nextPageUrl = deriveNextPageUrl(nextPageUrl, pageNumber);
        }

        const pageResults = await mapWithConcurrency(pageJobs, PAGE_FETCH_CONCURRENCY, async (job) => {
            if (allAgents.length >= validatedMaxResults) return null;

            log.info(`Page ${job.pageNumber}/${targetPageCount} - Collected: ${allAgents.length}/${validatedMaxResults}`, {
                url: job.url,
            });

            try {
                const fetched = await pageFetcher.fetchHtml({
                    url: job.url,
                    referer: searchUrl,
                    retries: 2,
                });

                if (fetched.source.startsWith('http')) {
                    httpPagesUsed++;
                } else {
                    browserPagesUsed++;
                }

                const result = extractAgentsMultiTier(fetched.html, job.url, job.pageNumber);
                return { ...job, source: fetched.source, result, error: null };
            } catch (error) {
                return { ...job, source: null, result: null, error: error.message };
            }
        });

        for (const pageResult of pageResults.filter(Boolean).sort((left, right) => left.pageNumber - right.pageNumber)) {
            if (allAgents.length >= validatedMaxResults) break;

            if (pageResult.error) {
                log.warning(`Skipping page ${pageResult.pageNumber} due to fetch error: ${pageResult.error}`);
                continue;
            }

            if (!pageResult.result || pageResult.result.agents.length === 0) {
                log.warning(`No agents found on page ${pageResult.pageNumber}, skipping`, {
                    source: pageResult.source,
                });
                continue;
            }

            pagesProcessed++;
            log.info(`Found ${pageResult.result.agents.length} agents on page ${pageResult.pageNumber}`, {
                source: pageResult.source,
            });

            if (pageResult.result.totalResults && !totalResultsCount) {
                totalResultsCount = pageResult.result.totalResults;
            }

            addAgentsToDataset(pageResult.result.agents, pageResult.pageNumber);
        }

        await datasetPusher.flush();
    } finally {
        await pageFetcher.close();
    }

    log.info('='.repeat(70));
    log.info('SCRAPING COMPLETED SUCCESSFULLY');
    log.info('='.repeat(70));
    log.info(`Agents scraped: ${allAgents.length}/${validatedMaxResults}`);
    log.info(`Pages processed: ${pagesProcessed}/${validatedMaxPages}`);
    log.info(`HTTP pages used: ${httpPagesUsed}`);
    log.info(`Browser pages used: ${browserPagesUsed}`);
    log.info(`Total available: ${totalResultsCount || 'Unknown'}`);
    log.info('='.repeat(70));
});
