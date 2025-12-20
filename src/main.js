import { Actor, log } from 'apify';
import { Dataset, gotScraping } from 'crawlee';
import { chromium } from 'playwright';
import { load as cheerioLoad } from 'cheerio';

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const DOMAIN_BASE = 'https://www.domain.com.au';
const DEFAULT_AGENT_LOCATION = 'perth-wa-6000';

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
];

const STEALTHY_HEADERS = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
    DNT: '1',
    Referer: DOMAIN_BASE,
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="121", "Google Chrome";v="121"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
};

const ENABLE_BROWSER_FALLBACK = false;
const DEFAULT_PAGE_SIZE = 40;
const MAX_CARD_PARSE = 160;
const DATASET_BATCH_SIZE = 10;
const PLAYWRIGHT_TIMEOUT_MS = 45000;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
// JSON-LD EXTRACTION
// ============================================================================

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
            // Invalid JSON-LD, skip
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
// EMBEDDED STATE EXTRACTION
// ============================================================================

const createStealthHeaders = () => ({
    ...STEALTHY_HEADERS,
    'User-Agent': getRandomUserAgent(),
    Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: DOMAIN_BASE,
});

const safeJsonParse = (maybeJson) => {
    if (!maybeJson) return null;
    try {
        return JSON.parse(maybeJson);
    } catch (err) {
        log.debug(`JSON parse failed: ${err.message}`);
        return null;
    }
};

const extractEmbeddedState = (html) => {
    const patterns = [
        /window\.__APOLLO_STATE__\s*=\s*({.*?})\s*;?/s,
        /window\.__INITIAL_STATE__\s*=\s*({.*?})\s*;?/s,
        /window\.__INITIAL_DATA__\s*=\s*({.*?})\s*;?/s,
        /<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s,
        /<script[^>]+type="application\/json"[^>]*>(.*?)<\/script>/s,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) {
            const parsed = safeJsonParse(match[1]);
            if (parsed) return parsed;
        }
    }

    return null;
};

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

const deriveNextPageUrl = ({ url, currentPage }) => {
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

const extractTotalResults = (payload) => {
    const candidates = [
        payload?.totalResults,
        payload?.results?.total,
        payload?.data?.total,
        payload?.paging?.total,
        payload?.pagination?.total,
    ];
    return candidates.find((val) => typeof val === 'number') || null;
};

const extractAgentsFromJsonPayload = ({ payload, sourceUrl, currentPage }) => {
    const agentsArray = locateAgentArray(payload);
    const agents = agentsArray
        .map((item) => normalizeAgentFromJson(item))
        .filter((item) => item && (item.url || item.name));

    const totalResults = extractTotalResults(payload);

    let nextPage = null;
    const pagingCandidates = [payload?.paging, payload?.pagination, payload?.results?.paging, payload?.data?.paging];
    for (const paging of pagingCandidates) {
        if (paging?.next) {
            nextPage = ensureAbsoluteUrl(paging.next);
            break;
        }
        if (paging?.nextPage) {
            nextPage = ensureAbsoluteUrl(paging.nextPage);
            break;
        }
    }

    if (!nextPage && agents.length > 0) {
        nextPage = deriveNextPageUrl({ url: sourceUrl, currentPage });
    }

    return { agents, totalResults, nextPage };
};

const addMetadata = (agent) => {
    if (!agent) return agent;
    agent.scrapedAt = agent.scrapedAt || new Date().toISOString();
    agent.source = agent.source || DOMAIN_BASE;
    return agent;
};

// ============================================================================
// HTML PARSING METHOD
// ============================================================================

const scrapeAgentListingPage = async ({ url, proxyConfiguration, html = null, currentPage = 1 }) => {
    try {
        log.debug(`Scraping agent listing page: ${url}`);

        let pageHtml = html;

        if (!pageHtml) {
            const headers = createStealthHeaders();

            const response = await gotScraping({
                url,
                headers,
                proxyUrl: proxyConfiguration ? await proxyConfiguration.newUrl() : undefined,
                responseType: 'text',
                retry: {
                    limit: 2,
                    statusCodes: [408, 429, 500, 502, 503, 504],
                },
                timeout: { request: 15000 },
            });

            pageHtml = response.body;
        }

        const $ = cheerioLoad(pageHtml);
        const agents = [];
        let totalResults = null;
        let nextPageCandidate = null;

        const embeddedState = extractEmbeddedState(pageHtml);
        if (embeddedState) {
            const embeddedResult = extractAgentsFromJsonPayload({
                payload: embeddedState,
                sourceUrl: url,
                currentPage,
            });
            if (embeddedResult.agents.length > 0) {
                log.debug(`Extracted ${embeddedResult.agents.length} agents from embedded JSON`);
                embeddedResult.agents.forEach((a) => agents.push(addMetadata(a)));
                totalResults = embeddedResult.totalResults || totalResults;
                nextPageCandidate = embeddedResult.nextPage || nextPageCandidate;
            }
        }

        if (pageHtml.includes('403 Forbidden') || pageHtml.length < 1000) {
            log.warning('Possible blocking or incomplete page received');
        }

        let agentCards = [];
        agentCards = [
            ...$('[data-testid*="agent-card"], [data-testid*="agent-card-wrapper"], [data-testid*="agent-tile"], [data-testid*="agent-list-item"]').toArray(),
        ];
        log.debug(`[Strategy 1] Found ${agentCards.length} cards with data-testid patterns`);

        if (agentCards.length === 0) {
            agentCards = $('article.agent-card, article[class*="agent"], div[class*="agent-card"], div[class*="agent-profile"], li[class*="agent"]').toArray();
            log.debug(`[Strategy 2] Found ${agentCards.length} cards with class selectors`);
        }

        if (agentCards.length === 0) {
            agentCards = $('article, li, div[class*="card"]').toArray().filter((el) => {
                const text = $(el).text().toLowerCase();
                return text.includes('agent') || text.includes('agency');
            });
            log.debug(`[Strategy 3] Found ${agentCards.length} cards with generic selectors`);
        }

        if (agentCards.length === 0) {
            log.warning('No agent cards found with any selector strategy');
            log.debug(`Page HTML sample: ${pageHtml.substring(0, 500)}`);
        }

        if (agentCards.length > MAX_CARD_PARSE) {
            agentCards = agentCards.slice(0, MAX_CARD_PARSE);
        }

        for (const card of agentCards) {
            try {
                const $card = $(card);

                const hrefs = $card
                    .find('a[href]')
                    .map((_, el) => $(el).attr('href'))
                    .get();
                const agentHref = pickAgentHref(hrefs);
                const agentUrl = ensureAbsoluteUrl(agentHref);

                if (!isLikelyAgentUrl(agentUrl)) {
                    continue;
                }

                let nameText = cleanText($card.find('h3.css-1hakis5, [data-testid*="name"], [data-testid*="agent-name"], .agent-name, h2, h3, .title').first().text());
                if (!nameText) nameText = cleanText($card.find('a').first().text());
                if (!nameText || /find agents?/i.test(nameText)) continue;

                const agent = {
                    id: null,
                    url: agentUrl,
                    name: nameText,
                    title: cleanText($card.find('[class*="title"], [class*="position"], [class*="role"]').first().text()),
                    agency: cleanText($card.find('[data-testid*="agency"], .agency-name, [class*="agency"], [class*="company"]').first().text()),
                    agencyUrl: ensureAbsoluteUrl($card.find('a[href*="agency"], a[href*="agencies"]').first().attr('href')) || null,
                    phone: extractPhoneNumber(
                        $card.find('a[href^="tel:"], [data-testid*="phone"], .phone').first().text() ||
                        $card.find('a[href^="tel:"]').attr('href') || ''
                    ),
                    email: extractEmail(
                        $card.find('a[href^="mailto:"], [data-testid*="email"], .email').first().text() ||
                        $card.find('a[href^="mailto:"]').attr('href') || ''
                    ),
                    suburb: cleanText($card.find('[class*="suburb"], [class*="location"], [class*="address"]').first().text()),
                    profileImage: $card.find('img[data-testid*="agent"], img[alt*="agent"], img[alt*="Agent"]').first().attr('src') || null,
                    agencyLogo: $card.find('img[data-testid*="agency"], img[alt*="logo"], img[alt*="Logo"], img[class*="logo"]').first().attr('src') || null,
                    currentListings: cleanText($card.find('[class*="listing"], [data-testid*="listing"]').first().text()),
                    soldProperties: cleanText($card.find('[class*="sold"], [data-testid*="sold"]').first().text()),
                    rating: cleanText($card.find('[data-rating], .rating, .stars').first().attr('data-rating') || $card.find('.rating, .stars').first().text()),
                    source: DOMAIN_BASE,
                    scrapedAt: new Date().toISOString(),
                };

                const idMatch = agent.url?.match(/(\d{6,})(?:[/?#]|$)/);
                agent.id = idMatch ? idMatch[1] : null;

                agents.push(addMetadata(agent));
            } catch (err) {
                log.warning(`Failed to parse agent card: ${err.message}`);
            }
        }

        let nextPageLink = $('a[aria-label="Go to next page"]').attr('href');
        if (!nextPageLink) nextPageLink = $('a[rel="next"]').attr('href');
        if (!nextPageLink) nextPageLink = $('a[aria-label*="Next"]').attr('href');

        const totalResultsText = cleanText($('[data-testid*="total"], [class*="total-results"]').first().text());
        const totalMatch = totalResultsText?.match(/([\d,]+)/);
        if (totalMatch) totalResults = totalResults || parseInt(totalMatch[1].replace(/,/g, ''), 10);

        const nextPage = ensureAbsoluteUrl(nextPageCandidate || nextPageLink) || deriveNextPageUrl({ url, currentPage });

        return { agents, nextPage, totalResults };
    } catch (error) {
        log.error(`Failed to scrape agent listing page: ${error.message}`);
        return { agents: [], nextPage: null, totalResults: null };
    }
};

// ============================================================================
// PLAYWRIGHT BROWSER METHOD
// ============================================================================

const scrapeViaPlaywright = async ({ url, proxyConfiguration, currentPage = 1 }) => {
    let browser;

    try {
        log.debug(`Scraping via Playwright: ${url}`);

        const launchOptions = {
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-sandbox',
                '--disable-setuid-sandbox',
            ],
        };

        if (proxyConfiguration) {
            const proxyUrl = await proxyConfiguration.newUrl();
            launchOptions.proxy = { server: proxyUrl };
        }

        browser = await chromium.launch(launchOptions);
        const context = await browser.newContext({
            userAgent: getRandomUserAgent(),
            viewport: { width: 1920, height: 1080 },
            locale: 'en-AU',
        });

        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT_MS });

        try {
            await page.waitForSelector('h3.css-1hakis5, [data-testid*="agent"]', { timeout: PLAYWRIGHT_TIMEOUT_MS });
        } catch (e) {
            log.warning('Timeout waiting for agent cards, continuing anyway');
        }

        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 300;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });

        const html = await page.content();
        await browser.close();

        return await scrapeAgentListingPage({ url, proxyConfiguration, html, currentPage });
    } catch (error) {
        log.error(`Playwright scraping failed: ${error.message}`);
        if (browser) {
            try {
                await browser.close();
            } catch (_) {
                // ignore
            }
        }
        return { agents: [], nextPage: null, totalResults: null };
    }
};

// ============================================================================
// DETAIL PAGE SCRAPING
// ============================================================================

const scrapeAgentDetails = async ({ url, proxyConfiguration }) => {
    try {
        log.debug(`Scraping agent details: ${url}`);

        const headers = createStealthHeaders();
        const response = await gotScraping({
            url,
            headers,
            proxyUrl: proxyConfiguration ? await proxyConfiguration.newUrl() : undefined,
            responseType: 'text',
            retry: {
                limit: 1,
                statusCodes: [408, 429, 500, 502, 503, 504],
            },
            timeout: { request: 20000 },
        });

        const $ = cheerioLoad(response.body);
        const details = {};

        const jsonLdData = extractJsonLd(response.body);
        const jsonLdAgent = parseJsonLdAgent(jsonLdData);
        if (jsonLdAgent) Object.assign(details, jsonLdAgent);

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

        return details;
    } catch (error) {
        log.error(`Failed to scrape agent details: ${error.message}`);
        return {};
    }
};

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
        usePlaywright = false,
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
        Math.max(
            validatedMaxPages,
            pageEstimate,
            Math.ceil(validatedMaxResults / 15),
        ),
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

    let searchUrl = startUrl;

    if (location || suburb || state || agencyName || specialization) {
        let baseUrl = DOMAIN_BASE;

        if (location) {
            baseUrl = buildAgentLocationUrl(location.toLowerCase().replace(/\s+/g, '-'));
        } else if (suburb) {
            baseUrl = buildAgentLocationUrl(suburb.toLowerCase().replace(/\s+/g, '-'));
        } else if (state) {
            baseUrl = buildAgentLocationUrl(state.toLowerCase().replace(/\s+/g, '-'));
        } else {
            baseUrl = buildAgentLocationUrl(DEFAULT_AGENT_LOCATION);
        }

        const params = new URLSearchParams();
        if (agencyName) params.append('agency', agencyName);
        if (specialization) params.append('specialization', specialization);

        const queryString = params.toString();
        searchUrl = queryString ? `${baseUrl}?${queryString}` : baseUrl;
    }

    if (isRootAgentSearchUrl(searchUrl)) {
        searchUrl = buildAgentLocationUrl(DEFAULT_AGENT_LOCATION);
        log.warning(`Root search has no listings. Using default location: ${DEFAULT_AGENT_LOCATION}`);
    }

    log.info(`Final search URL: ${searchUrl}`);

    const allAgents = [];
    const seenIds = new Set();
    let currentPage = 1;
    let nextPageUrl = searchUrl;
    let totalResultsCount = null;
    const datasetPusher = createDatasetPusher(DATASET_BATCH_SIZE);
    const detailLimiter = collectDetails ? createConcurrencyLimiter(Math.max(1, Math.min(maxConcurrency || 3, 10))) : null;
    const detailTasks = [];
    let detailsCollected = 0;

    while (nextPageUrl && allAgents.length < validatedMaxResults && currentPage <= pageLimit) {
        log.info(
            `Page ${currentPage}/${pageLimit} - Collected: ${allAgents.length}/${validatedMaxResults}`,
            { url: nextPageUrl },
        );

        let result = await scrapeAgentListingPage({
            url: nextPageUrl,
            proxyConfiguration: proxyConfig,
            currentPage,
        });

        if ((!result || result.agents.length === 0) && (ENABLE_BROWSER_FALLBACK || usePlaywright)) {
            log.info('Attempting Playwright fallback...');
            result = await scrapeViaPlaywright({
                url: nextPageUrl,
                proxyConfiguration: proxyConfig,
                currentPage,
            });
        }

        if (!result || result.agents.length === 0) {
            log.warning(`No agents found on page ${currentPage}, stopping pagination`);
            break;
        }

        if (!result.nextPage && result.agents.length > 0) {
            result.nextPage = deriveNextPageUrl({ url: nextPageUrl, currentPage });
        }

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
                            if (!normalized.url || !isLikelyAgentUrl(normalized.url)) return;
                            const details = await scrapeAgentDetails({
                                url: normalized.url,
                                proxyConfiguration: proxyConfig,
                            });

                            for (const [key, value] of Object.entries(details)) {
                                if (value && !normalized[key]) normalized[key] = value;
                            }

                            detailsCollected++;
                            datasetPusher.enqueue({ ...addMetadata(normalized) });
                            await sleep(150 + Math.random() * 350);
                        } catch (error) {
                            log.warning(`Failed details for ${normalized.url}: ${error.message}`);
                            datasetPusher.enqueue({ ...addMetadata(normalized) });
                        }
                    }),
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
            const delay = 500 + Math.random() * 900;
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

    log.info('='.repeat(70));
    log.info('SCRAPING COMPLETED SUCCESSFULLY');
    log.info('='.repeat(70));
    log.info(`Agents scraped: ${allAgents.length}/${validatedMaxResults}`);
    log.info(`Pages processed: ${currentPage - 1}/${pageLimit}`);
    log.info(`Details collected: ${collectDetails ? 'YES' : 'NO'}`);
    log.info(`Total available: ${totalResultsCount || 'Unknown'}`);
    log.info('='.repeat(70));
});

// ============================================================================
// HELPER: Concurrency Limiter
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

    return (task) => new Promise((resolve, reject) => {
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
