// Domain.com.au Real Estate Agents Scraper - Modern Multi-Method Extraction
import { Actor, log } from 'apify';
import { Dataset, gotScraping } from 'crawlee';
import { chromium } from 'playwright';
import { load as cheerioLoad } from 'cheerio';

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const DOMAIN_BASE = 'https://www.domain.com.au';

// Stealthy User Agents rotation
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
];

const STEALTHY_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
    'DNT': '1',
    'Referer': DOMAIN_BASE,
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

const ENABLE_BROWSER_FALLBACK = true;
const PAGE_REQUEST_TIMEOUT_MS = 15000;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanText = (text) => {
    if (!text) return null;
    return text.replace(/\s+/g, ' ').trim();
};

const ensureAbsoluteUrl = (url) => {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    return `${DOMAIN_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
};

const isLikelyAgentUrl = (url) => {
    if (!url) return false;
    const normalized = ensureAbsoluteUrl(url);
    if (!normalized) return false;
    if (normalized === DOMAIN_BASE || normalized === `${DOMAIN_BASE}/`) return false;

    const lower = normalized.toLowerCase();
    return (
        lower.includes('/real-estate-agents/') ||
        lower.includes('/agent/') ||
        lower.includes('/agents/')
    );
};

const pickAgentHref = (hrefs) => {
    if (!hrefs || hrefs.length === 0) return null;
    const filtered = hrefs.filter((href) => href && !href.startsWith('#'));
    const candidate = filtered.find((href) => {
        const lower = href.toLowerCase();
        if (lower.startsWith('mailto:') || lower.startsWith('tel:')) return false;
        return (
            lower.includes('/real-estate-agents/') ||
            lower.includes('/agent/') ||
            lower.includes('/agents/')
        );
    });
    return candidate || filtered[0] || null;
};

const extractPhoneNumber = (text) => {
    if (!text) return null;
    const cleaned = cleanText(text);
    if (!cleaned) return null;
    // Match Australian phone numbers
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
        } catch (e) {
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
        
        if (type === 'Organization' || type === 'RealEstateAgency') {
            if (!agent.agency) {
                agent.agency = data.name;
            }
            if (!agent.agencyUrl) {
                agent.agencyUrl = data.url;
            }
            if (data.logo) {
                agent.agencyLogo = typeof data.logo === 'string' ? data.logo : data.logo.url;
            }
        }
    }

    return Object.keys(agent).length > 0 ? agent : null;
};

// ============================================================================
// JSON API / EMBEDDED STATE EXTRACTION
// ============================================================================

const DEFAULT_PAGE_SIZE = 40;
const MAX_CARD_PARSE = 160;
const DATASET_BATCH_SIZE = 10;

const createStealthHeaders = () => ({
    ...STEALTHY_HEADERS,
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': DOMAIN_BASE,
    'X-Requested-With': 'XMLHttpRequest',
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
        /window\.__REDUX_STATE__\s*=\s*({.*?})\s*;?/s,
        /<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s,
        /<script[^>]+id="__APOLLO_STATE__"[^>]*>(.*?)<\/script>/s,
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
            obj.email ||
            obj.phone ||
            obj.profileUrl ||
            obj.agencyName
    );
};

const locateAgentArray = (payload) => {
    const visited = new Set();
    const queue = [payload];

    while (queue.length) {
        const current = queue.shift();
        if (!current) continue;
        if (typeof current === 'object') {
            if (visited.has(current)) continue;
            visited.add(current);
        }

        if (Array.isArray(current)) {
            const agentCandidates = current.filter(isAgentLike);
            if (agentCandidates.length > 0) return agentCandidates;
        }

        if (current && typeof current === 'object') {
            for (const value of Object.values(current)) {
                if (value && (typeof value === 'object' || Array.isArray(value))) {
                    queue.push(value);
                }
            }
        }
    }

    return [];
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
        agentData.canonicalUrl ||
        (agentData.agentSlug ? ensureAbsoluteUrl(agentData.agentSlug) : null);
    const normalizedUrl = ensureAbsoluteUrl(urlCandidate);

    const agent = {
        id: String(agentData.id || agentData.agentId || agentData.profileId || '') || null,
        url: isLikelyAgentUrl(normalizedUrl) ? normalizedUrl : null,
        name: agentData.name || agentData.agentName || 
              (agentData.firstName && agentData.lastName ? `${agentData.firstName} ${agentData.lastName}` : null),
        firstName: agentData.firstName || null,
        lastName: agentData.lastName || null,
        title: agentData.title || agentData.jobTitle || agentData.position || null,
        agency: agency.name || agentData.agencyName || null,
        agencyUrl: ensureAbsoluteUrl(agency.url || agentData.agencyUrl) || null,
        phone: contact.phone || agentData.phone || agentData.phoneNumber || null,
        mobile: contact.mobile || agentData.mobile || agentData.mobileNumber || null,
        email: contact.email || agentData.email || null,
        officeAddress: contact.address || agency.address || agentData.officeAddress || null,
        suburb: contact.suburb || agency.suburb || agentData.suburb || null,
        state: contact.state || agency.state || agentData.state || null,
        postcode: contact.postcode || agency.postcode || agentData.postcode || null,
        profileImage: agentData.profileImage || agentData.image || agentData.photo || null,
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

const withPageParams = (url, page) => {
    try {
        const parsed = new URL(url);
        const currentPage = Number.isFinite(page) ? page : parseInt(parsed.searchParams.get('page') || '1', 10) || 1;
        parsed.searchParams.set('page', String(currentPage));
        if (!parsed.searchParams.get('pageSize')) parsed.searchParams.set('pageSize', String(DEFAULT_PAGE_SIZE));
        return parsed.toString();
    } catch (err) {
        log.debug(`Failed to apply page params: ${err.message}`);
        return url;
    }
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

const findFirstAgentObject = (payload) => {
    const visited = new Set();
    const queue = [payload];

    while (queue.length) {
        const current = queue.shift();
        if (!current) continue;
        if (typeof current === 'object') {
            if (visited.has(current)) continue;
            visited.add(current);
        }

        if (isAgentLike(current)) return current;

        if (current && typeof current === 'object') {
            for (const value of Object.values(current)) {
                if (value && (typeof value === 'object' || Array.isArray(value))) {
                    queue.push(value);
                }
            }
        }
    }

    return null;
};

const createJsonApiCandidates = (url, page) => {
    const candidates = new Set();

    try {
        const parsed = new URL(url);
        const params = new URLSearchParams(parsed.search);
        params.set('page', String(page));
        if (!params.get('pageSize')) params.set('pageSize', String(DEFAULT_PAGE_SIZE));

        const query = params.toString();
        candidates.add(`${DOMAIN_BASE}/real-estate-agents/api/search?${query}`);
        candidates.add(`${DOMAIN_BASE}/api/agents/search?${query}`);
        candidates.add(`${DOMAIN_BASE}/real-estate-agents/api/list?${query}`);
        candidates.add(`${DOMAIN_BASE}/rea/api/agents/search?${query}`);
        candidates.add(`${DOMAIN_BASE}/rea/api/agents?${query}`);
        candidates.add(`${DOMAIN_BASE}/api/agents?${query}`);
        candidates.add(`${DOMAIN_BASE}/agents/api/list?${query}`);
    } catch (err) {
        log.debug(`Failed to build API candidates: ${err.message}`);
    }

    return Array.from(candidates);
};

const fetchAgentsViaJsonApi = async ({ url, page, proxyConfiguration }) => {
    const pageUrl = withPageParams(url, page);
    const apiCandidates = createJsonApiCandidates(pageUrl, page);
    for (const apiUrl of apiCandidates) {
        try {
            const response = await gotScraping({
                url: apiUrl,
                headers: createStealthHeaders(),
                responseType: 'text',
                proxyUrl: proxyConfiguration ? await proxyConfiguration.newUrl() : undefined,
                retry: {
                    limit: 1,
                    statusCodes: [408, 429, 500, 502, 503, 504],
                },
                timeout: { request: PAGE_REQUEST_TIMEOUT_MS },
            });

            const payload = safeJsonParse(response.body);
            if (!payload) continue;

            const extracted = extractAgentsFromJsonPayload({
                payload,
                sourceUrl: url,
                currentPage: page,
            });

            if (extracted.agents.length > 0) {
                log.debug(`JSON API succeeded via ${apiUrl} with ${extracted.agents.length} agents`);
                return { ...extracted, apiUrl, agents: extracted.agents.map(addMetadata) };
            }
        } catch (err) {
            log.debug(`JSON API candidate failed (${apiUrl}): ${err.message}`);
        }
    }

    return { agents: [], nextPage: null, totalResults: null };
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

        // First try the JSON API route (fastest and cheapest)
        if (!html) {
            const apiResult = await fetchAgentsViaJsonApi({
                url,
                page: currentPage,
                proxyConfiguration,
            });
            if (apiResult.agents.length > 0) {
                return apiResult;
            }
        }
        
        const targetUrl = withPageParams(url, currentPage);
        let pageHtml = html;
        
        if (!pageHtml) {
            const headers = createStealthHeaders();

            const response = await gotScraping({
                url: targetUrl,
                headers,
                proxyUrl: proxyConfiguration ? await proxyConfiguration.newUrl() : undefined,
                responseType: 'text',
                retry: {
                    limit: 2,
                    statusCodes: [408, 429, 500, 502, 503, 504],
                },
                timeout: { request: PAGE_REQUEST_TIMEOUT_MS },
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

        // Validate we got HTML content
        if (pageHtml.includes('403 Forbidden') || pageHtml.length < 1000) {
            log.warning('Possible blocking or incomplete page received');
        }

        // Parse agent cards from HTML - multiple selector strategies
        let agentCards = [];
        
        // Strategy 1: Try data-testid selectors (newer Domain interface)
        agentCards = $('[data-testid*="agent-card"], [data-testid*="agent-profile"]').toArray();
        log.debug(`[Strategy 1] Found ${agentCards.length} cards with data-testid`);
        
        // Strategy 2: Try class-based selectors (common pattern)
        if (agentCards.length === 0) {
            agentCards = $('article.agent-card, article[class*="agent"], div[class*="agent-card"], div[class*="agent-profile"]').toArray();
            log.debug(`[Strategy 2] Found ${agentCards.length} cards with class selectors`);
        }
        
        // Strategy 3: Try generic container selectors
        if (agentCards.length === 0) {
            agentCards = $('article, div[class*="card"]').toArray().filter((el) => {
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
                
                const agent = {};
                
                // Extract URL - pick the most likely agent link
                const hrefs = $card
                    .find('a[href]')
                    .map((_, el) => $(el).attr('href'))
                    .get();
                const agentHref = pickAgentHref(hrefs);
                agent.url = ensureAbsoluteUrl(agentHref);

                if (!isLikelyAgentUrl(agent.url)) {
                    log.debug('Skipping card: no valid agent URL found');
                    continue;
                }

                // Extract ID from URL (if present)
                const idMatch = agent.url?.match(/(\d{6,})(?:[/?#]|$)/);
                agent.id = idMatch ? idMatch[1] : null;

                // Extract agent name - Strategy: Try multiple selectors
                let nameText = cleanText($card.find('h2, h3, [class*="name"]').first().text());
                if (!nameText) nameText = cleanText($card.find('[data-testid*="name"]').first().text());
                if (!nameText) nameText = cleanText($card.find('a').first().text());
                agent.name = nameText || null;

                // Extract title/position
                const titleText = cleanText($card.find('[class*="title"], [class*="position"], [class*="role"]').first().text());
                agent.title = titleText || null;

                // Extract agency name
                const agencyText = cleanText($card.find('[class*="agency"], [class*="company"]').first().text());
                agent.agency = agencyText || null;

                // Extract agency URL
                const agencyLink = $card.find('a[href*="agency"], a[href*="agencies"]').first();
                agent.agencyUrl = ensureAbsoluteUrl(agencyLink.attr('href')) || null;

                // Extract phone number
                const phoneText = $card.find('[class*="phone"], a[href^="tel:"]').first().text() || 
                                 $card.find('a[href^="tel:"]').attr('href') || '';
                agent.phone = extractPhoneNumber(phoneText) || null;

                // Extract email
                const emailText = $card.find('[class*="email"], a[href^="mailto:"]').first().text() || 
                                 $card.find('a[href^="mailto:"]').attr('href') || '';
                agent.email = extractEmail(emailText) || null;

                // Extract suburb/location
                const suburbText = cleanText($card.find('[class*="suburb"], [class*="location"], [class*="address"]').first().text());
                agent.suburb = suburbText || null;

                // Extract profile image
                const imgElem = $card.find('img[src*="domain"], img[src*="cloudinary"], img[alt*="agent"], img[alt*="Agent"]').first();
                agent.profileImage = imgElem.attr('src') || imgElem.attr('data-src') || null;

                // Extract agency logo
                const logoElem = $card.find('img[alt*="logo"], img[alt*="Logo"], img[class*="logo"]').first();
                agent.agencyLogo = logoElem.attr('src') || logoElem.attr('data-src') || null;

                // Extract current listings count
                const listingsText = $card.find('[class*="listings"], [data-testid*="listings"]').text();
                const listingsMatch = listingsText.match(/(\d+)/);
                agent.currentListings = listingsMatch ? parseInt(listingsMatch[1], 10) : null;

                // Extract sold properties count
                const soldText = $card.find('[class*="sold"], [data-testid*="sold"]').text();
                const soldMatch = soldText.match(/(\d+)/);
                agent.soldProperties = soldMatch ? parseInt(soldMatch[1], 10) : null;

                // Extract rating
                const ratingText = $card.find('[class*="rating"], [data-testid*="rating"]').text();
                const ratingMatch = ratingText.match(/([\d.]+)/);
                agent.rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

                // Extract review count
                const reviewText = $card.find('[class*="review"], [data-testid*="review"]').text();
                const reviewMatch = reviewText.match(/(\d+)/);
                agent.reviewCount = reviewMatch ? parseInt(reviewMatch[1], 10) : null;

                agents.push(addMetadata(agent));
                log.debug(`Extracted agent: ${agent.name} - ${agent.agency}`);
                
            } catch (err) {
                log.warning(`Failed to parse agent card: ${err.message}`);
            }
        }

        // Try to find pagination info
        let nextPageLink = $('a[aria-label="Go to next page"]').attr('href');
        if (!nextPageLink) nextPageLink = $('a[rel="next"]').attr('href');

        const totalResultsText = cleanText($('[data-testid="summary-header-total-results"], [class*="total-results"]').text());
        const totalMatch = totalResultsText?.match(/([\d,]+)/);
        if (totalMatch) totalResults = totalResults || parseInt(totalMatch[1].replace(/,/g, ''), 10);

        const nextPage = ensureAbsoluteUrl(nextPageCandidate || nextPageLink) || deriveNextPageUrl({ url: targetUrl, currentPage });

        return {
            agents,
            nextPage,
            totalResults,
        };
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
    let context;
    
    try {
        const targetUrl = withPageParams(url, currentPage);
        log.debug(`Scraping via Playwright: ${targetUrl}`);
        
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
        context = await browser.newContext({
            userAgent: getRandomUserAgent(),
            viewport: { width: 1920, height: 1080 },
            locale: 'en-AU',
        });

        const page = await context.newPage();
        
        // Navigate to page
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        
        // Wait for content to load
        try {
            await page.waitForSelector('[data-testid*="agent"], .agent-card, [class*="agent"]', { timeout: 30000 });
        } catch (e) {
            log.warning('Timeout waiting for agent cards, continuing anyway');
        }
        
        // Scroll to load lazy images
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

        // Get page content
        const html = await page.content();
        
        await browser.close();

        // Parse with cheerio
        return await scrapeAgentListingPage({ url: targetUrl, proxyConfiguration, html, currentPage });
    } catch (error) {
        log.error(`Playwright scraping failed: ${error.message}`);
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                // Ignore
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

        let response = null;
        let lastError = null;
        const maxAttempts = 2;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                response = await gotScraping({
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
                break;
            } catch (err) {
                lastError = err;
                log.debug(`Detail request failed (attempt ${attempt}/${maxAttempts}): ${err.message}`);
            }
        }

        if (!response) {
            const message = lastError ? lastError.message : 'Detail request failed';
            throw new Error(message);
        }

        const $ = cheerioLoad(response.body);
        const details = {};

        // Extract JSON-LD first
        const jsonLdData = extractJsonLd(response.body);
        const jsonLdAgent = parseJsonLdAgent(jsonLdData);
        
        if (jsonLdAgent) {
            Object.assign(details, jsonLdAgent);
        }

        const embeddedState = extractEmbeddedState(response.body);
        if (embeddedState) {
            const embeddedDetails = extractAgentsFromJsonPayload({
                payload: embeddedState,
                sourceUrl: url,
                currentPage: 1,
            });
            if (embeddedDetails.agents.length > 0) {
                Object.assign(details, embeddedDetails.agents[0]);
            } else {
                const embeddedAgent = findFirstAgentObject(embeddedState);
                if (embeddedAgent) {
                    const normalized = normalizeAgentFromJson(embeddedAgent);
                    if (normalized) Object.assign(details, normalized);
                }
            }
        }

        // Extract full name
        if (!details.name) {
            details.name = cleanText($('[data-testid="agent-profile-name"], h1, [class*="agent-name"]').first().text());
        }

        // Extract title/position
        if (!details.title) {
            details.title = cleanText($('[data-testid="agent-profile-title"], [class*="agent-title"], [class*="position"]').first().text());
        }

        // Extract biography/description
        const bioElem = $('[data-testid="agent-profile-bio"], [data-testid="agent-description"], [class*="biography"], [class*="bio"]');
        details.biography = cleanText(bioElem.text()) || details.biography;

        // Extract agency information
        if (!details.agency) {
            details.agency = cleanText($('[data-testid="agency-name"], [class*="agency-name"]').first().text());
        }

        // Extract contact information
        const phoneElem = $('[data-testid="agent-phone"], [class*="phone"], a[href^="tel:"]');
        if (phoneElem.length && !details.phone) {
            details.phone = extractPhoneNumber(phoneElem.text() || phoneElem.attr('href'));
        }

        const mobileElem = $('[data-testid="agent-mobile"], [class*="mobile"]');
        if (mobileElem.length && !details.mobile) {
            details.mobile = extractPhoneNumber(mobileElem.text());
        }

        const emailElem = $('[data-testid="agent-email"], [class*="email"], a[href^="mailto:"]');
        if (emailElem.length && !details.email) {
            details.email = extractEmail(emailElem.text() || emailElem.attr('href'));
        }

        // Extract address
        if (!details.officeAddress) {
            details.officeAddress = cleanText($('[data-testid="agent-address"], [class*="office-address"], [class*="address"]').first().text());
        }

        // Extract suburb, state, postcode
        if (!details.suburb) {
            details.suburb = cleanText($('[data-testid="agent-suburb"], [class*="suburb"]').first().text());
        }

        if (!details.state) {
            details.state = cleanText($('[data-testid="agent-state"], [class*="state"]').first().text());
        }

        if (!details.postcode) {
            const postcodeText = cleanText($('[data-testid="agent-postcode"], [class*="postcode"]').first().text());
            const postcodeMatch = postcodeText?.match(/\d{4}/);
            details.postcode = postcodeMatch ? postcodeMatch[0] : null;
        }

        // Extract specializations
        const specializationsElem = $('[data-testid="agent-specializations"], [class*="specializations"], [class*="specialties"]');
        if (specializationsElem.length) {
            const specs = [];
            specializationsElem.find('li, span, div').each((_, el) => {
                const spec = cleanText($(el).text());
                if (spec && spec.length < 50) specs.push(spec);
            });
            if (specs.length > 0) details.specializations = specs;
        }

        // Extract languages
        const languagesElem = $('[data-testid="agent-languages"], [class*="languages"]');
        if (languagesElem.length) {
            const langs = [];
            languagesElem.find('li, span').each((_, el) => {
                const lang = cleanText($(el).text());
                if (lang) langs.push(lang);
            });
            if (langs.length > 0) details.languages = langs;
        }

        // Extract areas served
        const areasElem = $('[data-testid="agent-areas"], [class*="areas-served"], [class*="service-areas"]');
        if (areasElem.length) {
            const areas = [];
            areasElem.find('li, span, a').each((_, el) => {
                const area = cleanText($(el).text());
                if (area && area.length < 50) areas.push(area);
            });
            if (areas.length > 0) details.areasServed = areas;
        }

        // Extract performance metrics
        if (!details.currentListings) {
            const listingsText = $('[data-testid="agent-current-listings"], [class*="current-listings"]').text();
            const listingsMatch = listingsText.match(/(\d+)/);
            details.currentListings = listingsMatch ? parseInt(listingsMatch[1], 10) : null;
        }

        if (!details.soldProperties) {
            const soldText = $('[data-testid="agent-sold"], [class*="sold-properties"]').text();
            const soldMatch = soldText.match(/(\d+)/);
            details.soldProperties = soldMatch ? parseInt(soldMatch[1], 10) : null;
        }

        if (!details.rentedProperties) {
            const rentedText = $('[data-testid="agent-rented"], [class*="rented-properties"]').text();
            const rentedMatch = rentedText.match(/(\d+)/);
            details.rentedProperties = rentedMatch ? parseInt(rentedMatch[1], 10) : null;
        }

        // Extract rating and reviews
        if (!details.rating) {
            const ratingText = $('[data-testid="agent-rating"], [class*="rating"]').text();
            const ratingMatch = ratingText.match(/([\d.]+)/);
            details.rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
        }

        if (!details.reviewCount) {
            const reviewText = $('[data-testid="agent-reviews"], [class*="review-count"]').text();
            const reviewMatch = reviewText.match(/(\d+)/);
            details.reviewCount = reviewMatch ? parseInt(reviewMatch[1], 10) : null;
        }

        // Extract profile image
        if (!details.profileImage) {
            const profileImg = $('[data-testid="agent-profile-image"], img[alt*="agent"], img[alt*="Agent"]').first();
            details.profileImage = profileImg.attr('src') || profileImg.attr('data-src') || null;
        }

        // Extract agency logo
        if (!details.agencyLogo) {
            const logoImg = $('img[alt*="logo"], img[alt*="Logo"], [class*="agency-logo"] img').first();
            details.agencyLogo = logoImg.attr('src') || logoImg.attr('data-src') || null;
        }

        // Extract years of experience
        const experienceText = $('[data-testid="agent-experience"], [class*="experience"], [class*="years"]').text();
        const experienceMatch = experienceText.match(/(\d+)\s*year/i);
        if (experienceMatch) {
            details.yearsExperience = parseInt(experienceMatch[1], 10);
        }

        details.scrapedAt = details.scrapedAt || new Date().toISOString();
        details.source = details.source || DOMAIN_BASE;

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
        startUrl = 'https://www.domain.com.au/real-estate-agents/',
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
    } = input;

    const proxyConfig = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : null;

    // ========================================================================
    // INPUT VALIDATION
    // ========================================================================
    
    const validatedMaxResults = Math.max(1, Math.min(maxResults || 50, 1000));
    const validatedMaxPages = Math.max(1, Math.min(maxPages || 5, 50));
    const pageEstimate = Math.ceil(validatedMaxResults / Math.max(20, DEFAULT_PAGE_SIZE));
    const pageLimit = Math.min(
        50,
        Math.max(
            validatedMaxPages,
            pageEstimate,
            Math.ceil(validatedMaxResults / 15), // ensure enough pages when dedup/filters drop items
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

    // Build search URL with filters
    let searchUrl = startUrl;
    
    if (location || suburb || state || agencyName || specialization) {
        let baseUrl = DOMAIN_BASE;
        
        if (state) {
            baseUrl = `${DOMAIN_BASE}/real-estate-agents/${state.toLowerCase()}/`;
        } else if (location) {
            baseUrl = `${DOMAIN_BASE}/real-estate-agents/${location.toLowerCase().replace(/\s+/g, '-')}/`;
        } else if (suburb) {
            baseUrl = `${DOMAIN_BASE}/real-estate-agents/${suburb.toLowerCase().replace(/\s+/g, '-')}/`;
        } else {
            baseUrl = `${DOMAIN_BASE}/real-estate-agents/`;
        }
        
        const params = new URLSearchParams();
        
        if (agencyName) {
            params.append('agency', agencyName);
        }
        
        if (specialization) {
            params.append('specialization', specialization);
        }
        
        const queryString = params.toString();
        searchUrl = queryString ? `${baseUrl}?${queryString}` : baseUrl;
    }

    searchUrl = withPageParams(searchUrl, 1);
    log.info(`Final search URL: ${searchUrl}`);

    const allAgents = [];
    const seenIds = new Set();
    let currentPage = 1;
    let nextPageUrl = searchUrl;
    let totalResultsCount = null;
    const datasetPusher = createDatasetPusher(DATASET_BATCH_SIZE);
    const maxDetailConcurrency = Math.max(1, Math.min(maxConcurrency || 3, 10));
    const detailLimiter = collectDetails ? createConcurrencyLimiter(maxDetailConcurrency) : null;
    const detailTasks = [];
    let detailsCollected = 0;

    // Scraping loop
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

        if ((!result || result.agents.length === 0) && ENABLE_BROWSER_FALLBACK) {
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

        // Deduplicate and add agents
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

        // Rate limiting: human-like delays
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

    // Final report
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
