import { Actor, log } from 'apify';
import { Dataset, gotScraping } from 'crawlee';
import { firefox } from 'playwright';
import { load as cheerioLoad } from 'cheerio';

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

// Rotate through multiple realistic user agents
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:127.0) Gecko/20100101 Firefox/127.0',
];

const STEALTHY_HEADERS = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
    DNT: '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
    Connection: 'keep-alive',
};

// Timings
const PLAYWRIGHT_TIMEOUT_MS = 60000;
const NAVIGATION_TIMEOUT_MS = 45000;
const DEFAULT_PAGE_SIZE = 40;
const MAX_CARD_PARSE = 160;
const DATASET_BATCH_SIZE = 10;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const randomDelay = (min = 500, max = 1500) => sleep(min + Math.random() * (max - min));

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

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

const buildAgentLocationUrl = (slug) => `${DOMAIN_BASE}/real-estate-agents/${slug}/`;

const isRootAgentSearchUrl = (url) => {
    try {
        const parsed = new URL(url);
        const normalizedPath = parsed.pathname.replace(/\/+$/, '/');
        return normalizedPath === '/real-estate-agents/';
    } catch (_) {
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
    } catch (_) {
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
// SESSION MANAGER - Handles Browser Session with Stealth & Cookie Management
// ============================================================================

class SessionManager {
    constructor(proxyConfiguration) {
        this.proxyConfiguration = proxyConfiguration;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.cookies = [];
        this.userAgent = getRandomUserAgent();
        this.isInitialized = false;
    }

    async initialize() {
        log.info('Initializing stealthy Firefox session...');

        const launchOptions = {
            headless: true,
            // Firefox-specific stealth args
            firefoxUserPrefs: {
                // Disable telemetry
                'toolkit.telemetry.enabled': false,
                'toolkit.telemetry.unified': false,
                'toolkit.telemetry.archive.enabled': false,
                // Disable tracking protection to avoid issues
                'privacy.trackingprotection.enabled': false,
                'privacy.trackingprotection.pbmode.enabled': false,
                // Disable webdriver detection
                'dom.webdriver.enabled': false,
                // Disable navigator.webdriver
                'marionette.enabled': false,
                // Enable WebGL (some sites check this)
                'webgl.disabled': false,
                // Disable safe browsing (can cause delays)
                'browser.safebrowsing.enabled': false,
                'browser.safebrowsing.malware.enabled': false,
                // Disable prefetching
                'network.prefetch-next': false,
                'network.dns.disablePrefetch': true,
                // Disable service workers
                'dom.serviceWorkers.enabled': false,
            },
        };

        // Add proxy if configured
        if (this.proxyConfiguration) {
            const proxyUrl = await this.proxyConfiguration.newUrl();
            if (proxyUrl) {
                const parsedProxy = new URL(proxyUrl);
                launchOptions.proxy = {
                    server: `${parsedProxy.protocol}//${parsedProxy.hostname}:${parsedProxy.port}`,
                    username: parsedProxy.username,
                    password: parsedProxy.password,
                };
                log.debug(`Using proxy: ${parsedProxy.hostname}`);
            }
        }

        this.browser = await firefox.launch(launchOptions);

        // Create context with realistic settings
        const viewportWidth = 1920 + randomInt(-100, 100);
        const viewportHeight = 1080 + randomInt(-50, 50);

        this.context = await this.browser.newContext({
            userAgent: this.userAgent,
            viewport: { width: viewportWidth, height: viewportHeight },
            locale: 'en-AU',
            timezoneId: 'Australia/Sydney',
            geolocation: { latitude: -31.9505, longitude: 115.8605 }, // Perth
            permissions: ['geolocation'],
            colorScheme: 'light',
            deviceScaleFactor: 1,
            hasTouch: false,
            isMobile: false,
            javaScriptEnabled: true,
            bypassCSP: true,
            ignoreHTTPSErrors: true,
            extraHTTPHeaders: {
                'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
                DNT: '1',
            },
        });

        // Block unnecessary resources for speed
        await this.context.route('**/*', async (route) => {
            const request = route.request();
            const resourceType = request.resourceType();
            const url = request.url();

            // Block tracking and analytics
            const blockedPatterns = [
                'google-analytics',
                'googletagmanager',
                'facebook.net',
                'doubleclick',
                'hotjar',
                'segment.io',
                'amplitude',
                'mixpanel',
                'newrelic',
                'optimizely',
                'clarity.ms',
            ];

            const shouldBlock = blockedPatterns.some((pattern) => url.includes(pattern));

            if (shouldBlock) {
                await route.abort();
            } else if (['font', 'media'].includes(resourceType)) {
                // Block fonts and media to speed up
                await route.abort();
            } else {
                await route.continue();
            }
        });

        this.page = await this.context.newPage();

        // Remove automation indicators
        await this.page.addInitScript(() => {
            // Override webdriver property
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });

            // Override plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                    { name: 'Native Client', filename: 'internal-nacl-plugin' },
                ],
            });

            // Override languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-AU', 'en-US', 'en'],
            });

            // Override platform
            Object.defineProperty(navigator, 'platform', {
                get: () => 'Win32',
            });

            // Override hardware concurrency
            Object.defineProperty(navigator, 'hardwareConcurrency', {
                get: () => 8,
            });

            // Override device memory
            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => 8,
            });

            // Add Chrome object for compatibility
            window.chrome = {
                runtime: {},
                loadTimes: () => ({}),
                csi: () => ({}),
                app: {},
            };

            // Override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : originalQuery(parameters);
        });

        // Skip homepage warm-up for faster initialization
        // The stealth options are sufficient for Domain.com.au
        this.isInitialized = true;
        log.info('Stealthy Firefox session initialized');
        return this;
    }

    async simulateHumanBehavior() {
        try {
            // Random mouse movements
            const moves = randomInt(3, 6);
            for (let i = 0; i < moves; i++) {
                const x = randomInt(100, 1800);
                const y = randomInt(100, 900);
                await this.page.mouse.move(x, y, { steps: randomInt(5, 15) });
                await randomDelay(100, 300);
            }

            // Scroll down a bit
            await this.page.evaluate(() => {
                window.scrollBy(0, Math.random() * 500 + 200);
            });
            await randomDelay(500, 1000);

            // Scroll back up
            await this.page.evaluate(() => {
                window.scrollBy(0, -Math.random() * 300);
            });
        } catch (_) {
            // Ignore errors in simulation
        }
    }

    async navigateToUrl(url) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        log.debug(`Navigating to: ${url}`);

        try {
            const response = await this.page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: NAVIGATION_TIMEOUT_MS,
            });

            // Wait for any dynamic content
            await randomDelay(1500, 3000);

            // Simulate human behavior
            await this.simulateHumanBehavior();

            // Update cookies
            this.cookies = await this.context.cookies();

            const html = await this.page.content();
            const statusCode = response?.status() || 0;

            // Check for blocking
            if (html.includes('403 Forbidden') || html.includes('Access Denied') || html.includes('captcha')) {
                log.warning('Possible blocking detected, attempting to refresh session...');
                await this.refreshSession();
                return await this.navigateToUrl(url);
            }

            return { html, statusCode, cookies: this.cookies };
        } catch (error) {
            log.error(`Navigation failed: ${error.message}`);
            throw error;
        }
    }

    getCookieString() {
        return this.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }

    getCookiesForGot() {
        return this.getCookieString();
    }

    async refreshSession() {
        log.info('Refreshing browser session...');
        if (this.browser) {
            try {
                await this.browser.close();
            } catch (_) {
                // Ignore close errors
            }
        }
        this.isInitialized = false;
        this.userAgent = getRandomUserAgent();
        await this.initialize();
    }

    async close() {
        if (this.browser) {
            try {
                await this.browser.close();
            } catch (_) {
                // Ignore
            }
        }
        this.isInitialized = false;
    }
}

// ============================================================================
// HYBRID FETCH - Uses cookies from Playwright for got-scraping requests
// ============================================================================

const hybridFetch = async ({ url, sessionManager, retries = 2 }) => {
    const cookieString = sessionManager.getCookiesForGot();
    const userAgent = sessionManager.userAgent;

    const headers = {
        ...STEALTHY_HEADERS,
        'User-Agent': userAgent,
        Cookie: cookieString,
        Referer: DOMAIN_BASE,
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            log.debug(`Hybrid fetch attempt ${attempt}/${retries}: ${url}`);

            const response = await gotScraping({
                url,
                headers,
                responseType: 'text',
                timeout: { request: 20000 },
                retry: { limit: 0 },
                throwHttpErrors: false,
            });

            const body = response.body || '';
            const statusCode = response.statusCode;

            // Check for blocking
            if (statusCode === 403 || statusCode === 503 || body.includes('403 Forbidden') || body.includes('Access Denied')) {
                log.warning(`Request blocked (status: ${statusCode}), falling back to Playwright...`);
                throw new Error('Blocked response');
            }

            if (statusCode >= 200 && statusCode < 400 && body.length > 1000) {
                return { html: body, statusCode, source: 'got-scraping' };
            }

            throw new Error(`Invalid response: status=${statusCode}, length=${body.length}`);
        } catch (error) {
            log.debug(`Got-scraping failed: ${error.message}`);

            if (attempt === retries) {
                // Final attempt: use Playwright directly
                log.info('Falling back to Playwright for direct fetch...');
                const result = await sessionManager.navigateToUrl(url);
                return { ...result, source: 'playwright' };
            }

            await randomDelay(1000, 2000);
        }
    }

    // Should not reach here, but fallback anyway
    const result = await sessionManager.navigateToUrl(url);
    return { ...result, source: 'playwright' };
};

// ============================================================================
// MULTI-TIER DATA EXTRACTION
// ============================================================================

const extractNextData = (html) => {
    try {
        const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
        if (match?.[1]) {
            return JSON.parse(match[1]);
        }
    } catch (_) {
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
            } catch (_) {
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

    scripts.each((_, script) => {
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
        } catch (_) {
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
        agentData.profileUrl ||
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

const addMetadata = (agent) => {
    if (!agent) return agent;
    agent.scrapedAt = agent.scrapedAt || new Date().toISOString();
    agent.source = agent.source || DOMAIN_BASE;
    return agent;
};

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
    const agents = [];

    if (!apolloState || typeof apolloState !== 'object') {
        return agents;
    }

    // Helper to resolve Apollo State references (e.g., {"__ref": "Reputation:123"})
    const resolveRef = (obj) => {
        if (obj && obj.__ref && apolloState[obj.__ref]) {
            return apolloState[obj.__ref];
        }
        return obj;
    };

    // Find all ContactSearchContact entries
    const contactKeys = Object.keys(apolloState).filter(key =>
        key.startsWith('ContactSearchContact:')
    );

    log.debug(`Found ${contactKeys.length} ContactSearchContact entries in Apollo state`);

    for (const key of contactKeys) {
        try {
            const contact = apolloState[key];
            if (!contact || typeof contact !== 'object') continue;

            // Extract agent ID from key (e.g., "ContactSearchContact:1721099" -> "1721099")
            const idMatch = key.match(/ContactSearchContact:(\d+)/);
            const agentId = idMatch ? idMatch[1] : null;

            // Build profile URL
            const profileUrl = contact.profileUrl
                ? ensureAbsoluteUrl(contact.profileUrl)
                : (agentId ? `${DOMAIN_BASE}/real-estate-agent/${contact.name?.toLowerCase().replace(/\s+/g, '-')}-${agentId}/` : null);

            // Resolve reputation reference if it exists
            const reputation = resolveRef(contact.reputation) || {};

            // Extract first name by splitting full name
            let firstName = null;
            if (contact.name) {
                const nameParts = contact.name.trim().split(/\s+/);
                firstName = nameParts[0] || null;
            }

            const agent = {
                id: agentId,
                url: profileUrl,
                name: contact.name || null,
                firstName: firstName,
                lastName: contact.name ? contact.name.replace(firstName, '').trim() || null : null,
                title: contact.jobTitle || null,
                agency: contact.agencyName || null,
                agencyUrl: contact.agencyProfileUrl ? ensureAbsoluteUrl(contact.agencyProfileUrl) : null,
                phone: contact.telephone || contact.phone || null,
                mobile: contact.mobile || null,
                email: contact.hasEmail ? 'Available (click to reveal)' : null,  // Email not exposed directly
                hasEmail: contact.hasEmail || false,
                suburb: contact.suburb || contact.location || null,
                state: contact.state || null,
                postcode: contact.postcode || null,
                profileImage: contact.profilePhoto || contact.profilePhotoUrl || contact.photo || null,
                agencyLogo: contact.agencyLogoUrl || contact.agencyLogo || null,
                biography: contact.biography || contact.bio || contact.profileText || null,
                // Performance metrics - CORRECT FIELD NAMES
                averageSoldPrice: contact.averageSoldPrice || null,
                averageSoldDaysOnMarket: contact.averageSoldDaysOnMarket || null,
                propertiesForSale: contact.totalForSale ?? contact.propertiesForSale ?? null,
                propertiesForRent: contact.totalForRent ?? contact.propertiesForRent ?? null,
                propertiesSold: contact.totalSoldAndAuctioned ?? contact.propertiesSold ?? null,
                totalSoldAndAuctioned: contact.totalSoldAndAuctioned || null,
                // Reviews - CORRECT FIELD NAMES from reputation object
                rating: reputation.overallStarRating ?? reputation.starRating ?? contact.rating ?? null,
                reviewCount: reputation.numberOfReviews ?? reputation.reviewCount ?? contact.reviewCount ?? null,
                // Source
                source: DOMAIN_BASE,
                scrapedAt: new Date().toISOString(),
            };

            // Only add if we have valid data
            if (agent.name || agent.url) {
                agents.push(agent);
            }
        } catch (err) {
            log.debug(`Failed to parse contact ${key}: ${err.message}`);
        }
    }

    return agents;
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
        const apolloState = pageProps?.__APOLLO_STATE__;
        if (apolloState) {
            agents = extractAgentsFromApolloState(apolloState);
            if (agents.length > 0) {
                extractionMethod = '__APOLLO_STATE__';
                log.info(`Extracted ${agents.length} agents from __APOLLO_STATE__`);

                // Try to get pagination info from Apollo state
                const paginationKey = Object.keys(apolloState).find(k =>
                    k.includes('pagination') || k.includes('Pagination')
                );
                if (paginationKey) {
                    const paginationData = apolloState[paginationKey];
                    totalResults = paginationData?.totalResults || paginationData?.total || null;
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
                extractionMethod = '__NEXT_DATA__ (pageProps)';
                log.info(`Extracted ${agents.length} agents from __NEXT_DATA__ pageProps`);

                totalResults = pageProps.totalAgents || pageProps.total || pageProps.pagination?.total || null;
            }
        }
    }

    // Tier 2: Standalone Apollo/Initial State (window.__APOLLO_STATE__)
    if (agents.length === 0) {
        const apolloState = extractApolloState(html);
        if (apolloState) {
            agents = extractAgentsFromApolloState(apolloState);
            if (agents.length > 0) {
                extractionMethod = 'Apollo State (window)';
                log.info(`Extracted ${agents.length} agents from window Apollo State`);
            }

            // Fallback to generic search
            if (agents.length === 0) {
                const agentArray = locateAgentArray(apolloState);
                if (agentArray.length > 0) {
                    agents = agentArray
                        .map((item) => normalizeAgentFromJson(item))
                        .filter((item) => item && (item.url || item.name));
                    extractionMethod = 'Apollo State (generic)';
                    log.info(`Extracted ${agents.length} agents from Apollo State (generic)`);
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


const parseAgentsFromHtml = (html) => {
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
                propertiesSold: propertiesSold,
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
};

const deriveNextPageUrl = (url, currentPage) => {
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
};

// ============================================================================
// DETAIL PAGE SCRAPING
// ============================================================================

const scrapeAgentDetails = async ({ url, sessionManager }) => {
    try {
        log.debug(`Scraping agent details: ${url}`);

        const { html } = await hybridFetch({ url, sessionManager, retries: 2 });

        const $ = cheerioLoad(html);
        const details = {};

        // __NEXT_DATA__ extraction - Profile page has Contact object with more details
        const nextData = extractNextData(html);
        if (nextData?.props?.pageProps) {
            const pageProps = nextData.props.pageProps;
            const apolloState = pageProps.__APOLLO_STATE__;

            if (apolloState) {
                // Find the main Contact object (not ContactSearchContact)
                const contactKey = Object.keys(apolloState).find(k =>
                    k.startsWith('Contact:') && !k.includes('Search')
                );

                if (contactKey) {
                    const contact = apolloState[contactKey];

                    // Extract fields from profile page Contact object
                    details.firstName = contact.firstName || null;
                    details.biography = contact.profileText || contact.biography || null;
                    details.phone = contact.telephone || contact.phone || null;
                    details.mobile = contact.mobile || null;

                    // Get full name if available
                    if (contact.name && !details.firstName) {
                        const nameParts = contact.name.trim().split(/\s+/);
                        details.firstName = nameParts[0] || null;
                    }

                    // Check for listing stats in nested objects
                    const listingsKey = Object.keys(apolloState).find(k =>
                        k.includes('listingsByAgentIdV2')
                    );
                    if (listingsKey) {
                        const listings = apolloState[listingsKey];
                        if (listings) {
                            details.propertiesForSale = listings.saleListings?.total ?? null;
                            details.propertiesForRent = listings.leaseListings?.total ?? null;
                            details.propertiesSold = listings.soldListings?.total ?? null;
                        }
                    }
                }
            }

            // Fallback to agent in pageProps
            if (pageProps.agent) {
                const agentData = normalizeAgentFromJson(pageProps.agent);
                if (agentData) {
                    for (const [key, value] of Object.entries(agentData)) {
                        if (value && !details[key]) details[key] = value;
                    }
                }
            }
        }

        // JSON-LD extraction
        const jsonLdData = extractJsonLd(html);
        const jsonLdAgent = parseJsonLdAgent(jsonLdData);
        if (jsonLdAgent) {
            for (const [key, value] of Object.entries(jsonLdAgent)) {
                if (value && !details[key]) details[key] = value;
            }
        }

        // HTML fallback
        if (!details.name) {
            details.name = cleanText($('[data-testid="agent-profile-name"], h1, [class*="agent-name"]').first().text());
        }
        if (!details.title) {
            details.title = cleanText($('[data-testid="agent-profile-title"], [class*="agent-title"]').first().text());
        }
        if (!details.agency) {
            details.agency = cleanText($('[data-testid="agency-name"], [class*="agency-name"]').first().text());
        }
        if (!details.phone) {
            const phoneText = $('[data-testid="agent-phone"], [class*="phone"], a[href^="tel:"]').first().text();
            details.phone = extractPhoneNumber(phoneText);
        }
        if (!details.email) {
            const emailText = $('[data-testid="agent-email"], [class*="email"], a[href^="mailto:"]').first().text();
            details.email = extractEmail(emailText);
        }
        if (!details.officeAddress) {
            details.officeAddress = cleanText($('[data-testid="agent-address"], [class*="office-address"]').first().text());
        }
        if (!details.biography) {
            // Try multiple biography selectors
            details.biography = cleanText(
                $('[data-testid="agent-bio"], [class*="biography"], [class*="about-text"], [class*="profile-text"], .agent-bio, .about-section p').first().text()
            );

            // If still no biography, try to get all text from about section
            if (!details.biography) {
                const aboutSection = $('[class*="about"], [class*="bio"]').first();
                if (aboutSection.length) {
                    details.biography = cleanText(aboutSection.find('p').toArray().map(p => $(p).text()).join(' '));
                }
            }
        }

        // Clean up HTML from biography if present
        if (details.biography && details.biography.includes('<')) {
            details.biography = details.biography.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }

        return details;
    } catch (error) {
        log.warning(`Failed to scrape agent details: ${error.message}`);
        return {};
    }
};


// ============================================================================
// HELPER: Concurrency Limiter & Dataset Pusher
// ============================================================================

function createConcurrencyLimiter(maxConcurrency) {
    let active = 0;
    const queue = [];

    const next = () => {
        if (active >= maxConcurrency || queue.length === 0) return;

        active++;
        const { task, resolve, reject } = queue.shift();

        task()
            .then(resolve)
            .catch(reject)
            .finally(() => {
                active--;
                next();
            });
    };

    return (task) =>
        new Promise((resolve, reject) => {
            queue.push({ task, resolve, reject });
            next();
        });
}

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

// ============================================================================
// MAIN ACTOR LOGIC
// ============================================================================

Actor.main(async () => {
    const input = await Actor.getInput();

    const {
        startUrl = buildAgentLocationUrl(DEFAULT_AGENT_LOCATION),
        maxResults = 50,
        maxPages = 5,
        collectDetails = true,
        maxConcurrency = 3,
        proxyConfiguration,
        location = null,
        suburb = null,
        state = null,
        agencyName = null,
        specialization = null,
    } = input || {};

    const proxyConfig = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : null;

    const validatedMaxResults = Math.max(1, Math.min(maxResults || 50, 1000));
    const validatedMaxPages = Math.max(1, Math.min(maxPages || 5, 50));
    const pageEstimate = Math.ceil(validatedMaxResults / Math.max(20, DEFAULT_PAGE_SIZE));
    const pageLimit = Math.min(
        50,
        Math.max(validatedMaxPages, pageEstimate, Math.ceil(validatedMaxResults / 15))
    );

    if (!startUrl.includes('domain.com.au')) {
        throw new Error('Invalid input: startUrl must be from domain.com.au');
    }

    log.info('Domain.com.au Real Estate Agents Scraper started', {
        startUrl,
        maxResults: validatedMaxResults,
        maxPages: pageLimit,
        collectDetails,
    });

    // Build search URL - location options override startUrl if provided
    let searchUrl = startUrl;

    // Check if user provided location-based filters
    const hasLocationFilters = location || suburb || state;
    const hasOtherFilters = agencyName || specialization;

    // If any location filter is set, build URL from that (ignoring startUrl)
    if (hasLocationFilters || hasOtherFilters) {
        let locationSlug = null;

        if (location) {
            // User provided full location slug (e.g., "sydney-nsw-2000")
            locationSlug = location.toLowerCase().replace(/\s+/g, '-');
            log.info(`Using provided location: ${locationSlug}`);
        } else if (suburb) {
            // User provided suburb with postcode (e.g., "paddington-nsw-2021")
            locationSlug = suburb.toLowerCase().replace(/\s+/g, '-');
            log.info(`Using provided suburb: ${locationSlug}`);
        } else if (state) {
            // User only provided state - use state capital with postcode
            const stateKey = state.toLowerCase();
            locationSlug = STATE_CAPITALS[stateKey] || DEFAULT_AGENT_LOCATION;
            log.info(`Using state capital for ${state.toUpperCase()}: ${locationSlug}`);
        } else {
            // No location but has other filters - use default location
            locationSlug = DEFAULT_AGENT_LOCATION;
            log.info(`Using default location: ${locationSlug}`);
        }

        const baseUrl = buildAgentLocationUrl(locationSlug);

        const params = new URLSearchParams();
        if (agencyName) params.append('agency', agencyName);
        if (specialization) params.append('specialization', specialization);

        const queryString = params.toString();
        searchUrl = queryString ? `${baseUrl}?${queryString}` : baseUrl;
    }

    // Ensure we don't use root agent URL which returns no results
    if (isRootAgentSearchUrl(searchUrl)) {
        searchUrl = buildAgentLocationUrl(DEFAULT_AGENT_LOCATION);
        log.warning(`Root search URL detected. Using default location: ${DEFAULT_AGENT_LOCATION}`);
    }

    log.info(`Final search URL: ${searchUrl}`);

    // Initialize session manager with stealth browser
    const sessionManager = new SessionManager(proxyConfig);
    await sessionManager.initialize();

    const allAgents = [];
    const seenIds = new Set();
    let currentPage = 1;
    let nextPageUrl = searchUrl;
    let totalResultsCount = null;
    const datasetPusher = createDatasetPusher(DATASET_BATCH_SIZE);
    const detailLimiter = collectDetails ? createConcurrencyLimiter(Math.max(1, Math.min(maxConcurrency || 3, 10))) : null;
    const detailTasks = [];
    let detailsCollected = 0;

    try {
        while (nextPageUrl && allAgents.length < validatedMaxResults && currentPage <= pageLimit) {
            log.info(`Page ${currentPage}/${pageLimit} - Collected: ${allAgents.length}/${validatedMaxResults}`, {
                url: nextPageUrl,
            });

            // Fetch page using hybrid approach
            const { html, source } = await hybridFetch({
                url: nextPageUrl,
                sessionManager,
                retries: 2,
            });

            log.debug(`Page fetched via ${source}`);

            // Extract agents using multi-tier approach
            const result = extractAgentsMultiTier(html, nextPageUrl, currentPage);

            if (!result || result.agents.length === 0) {
                log.warning(`No agents found on page ${currentPage}, stopping pagination`);
                break;
            }

            log.info(`Extraction method: ${result.extractionMethod}, found ${result.agents.length} agents`);

            if (result.totalResults && !totalResultsCount) {
                totalResultsCount = result.totalResults;
                log.info(`Total available: ${totalResultsCount} agents`);
            }

            let addedThisPage = 0;
            const newItemsThisPage = [];
            for (const agent of result.agents) {
                const dedupeKey = agent.id || agent.url || agent.name;
                if (!dedupeKey || seenIds.has(dedupeKey)) continue;

                seenIds.add(dedupeKey);
                const normalized = addMetadata(agent);
                allAgents.push(normalized);
                newItemsThisPage.push({ ...normalized });
                addedThisPage++;

                if (collectDetails && detailLimiter) {
                    detailTasks.push(
                        detailLimiter(async () => {
                            try {
                                // Check if URL is valid for detail scraping
                                // Accept URLs with /real-estate-agent/ pattern
                                const hasValidUrl = normalized.url &&
                                    (normalized.url.includes('/real-estate-agent/') ||
                                        normalized.url.includes('/real-estate-agents/'));

                                if (hasValidUrl) {
                                    const details = await scrapeAgentDetails({
                                        url: normalized.url,
                                        sessionManager,
                                    });

                                    for (const [key, value] of Object.entries(details)) {
                                        if (value && !normalized[key]) normalized[key] = value;
                                    }
                                    detailsCollected++;
                                }

                                // ALWAYS push data to dataset
                                datasetPusher.enqueue({ ...addMetadata(normalized) });
                                await randomDelay(200, 500);
                            } catch (error) {
                                log.warning(`Failed details for ${normalized.url}: ${error.message}`);
                                // Still push data even on error
                                datasetPusher.enqueue({ ...addMetadata(normalized) });
                            }
                        })
                    );
                }

                if (allAgents.length >= validatedMaxResults) break;
            }

            log.info(`Added ${addedThisPage} unique agents (${allAgents.length}/${validatedMaxResults} total)`);
            if (!collectDetails && newItemsThisPage.length) {
                datasetPusher.enqueue(newItemsThisPage);
            }

            nextPageUrl = result.nextPage;
            currentPage++;

            if (nextPageUrl && allAgents.length < validatedMaxResults) {
                const delay = 1500 + Math.random() * 2000;
                log.debug(`Rate limiting: ${Math.round(delay)}ms before next page`);
                await sleep(delay);
            }
        }

        if (collectDetails && allAgents.length > 0) {
            log.info(`Collecting full details for ${allAgents.length} agents...`);
            await Promise.all(detailTasks);
            await datasetPusher.flush();
            log.info(`Details collected for ${detailsCollected}/${allAgents.length} agents`);
        } else {
            await datasetPusher.flush();
        }
    } finally {
        // Clean up browser
        await sessionManager.close();
    }

    log.info('='.repeat(70));
    log.info('SCRAPING COMPLETED SUCCESSFULLY');
    log.info('='.repeat(70));
    log.info(`Agents scraped: ${allAgents.length}/${validatedMaxResults}`);
    log.info(`Pages processed: ${currentPage - 1}/${pageLimit}`);
    log.info(`Details collected: ${collectDetails ? 'YES' : 'NO'}`);
    log.info(`Total available: ${totalResultsCount || 'Unknown'}`);
    log.info('='.repeat(70));
});
