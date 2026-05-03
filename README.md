# Domain.com.au Real Estate Agents Scraper

Extract real estate agent data from Domain.com.au search result pages across Australia. Collect agent names, agency details, profile links, phone numbers, listing activity, and review metrics in a structured dataset for outreach, research, and market analysis.

## Features

- **Structured agent collection** — Captures agent records directly from live search results
- **Clean output** — Removes null, empty, and duplicate values before saving data
- **Multi-page coverage** — Follows result pages until it reaches your requested limit
- **Location-based searches** — Start from a specific Domain search URL or use a state shortcut
- **Useful performance fields** — Includes sale activity, days on market, and review counts
- **Proxy-ready** — Supports Apify proxy configuration for more reliable runs

## Use Cases

### Lead Generation
Build targeted agent lists for B2B outreach, partnerships, and prospecting. Export clean profile and contact data for CRM enrichment and sales workflows.

### Market Research
Analyze which agencies and agents are active in specific suburbs or capital-city markets. Compare listing volume, sales activity, and review signals across regions.

### Competitive Monitoring
Track agent visibility and agency presence in priority areas. Use the data to understand who dominates a local market and where new opportunities exist.

### Data Enrichment
Append structured agent and agency details to existing real estate datasets. Use the output in reporting, dashboards, and internal databases.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | No | `https://www.domain.com.au/real-estate-agents/sydney-nsw-2000/` | Domain.com.au agent search URL to scrape |
| `state` | String | No | — | Optional state shortcut: `nsw`, `vic`, `qld`, `wa`, `sa`, `tas`, `act`, `nt` |
| `specialization` | String | No | — | Optional specialization filter |
| `maxResults` | Integer | No | `20` | Maximum number of agent records to collect |
| `maxPages` | Integer | No | `3` | Maximum number of result pages to process |
| `proxyConfiguration` | Object | No | `{"useApifyProxy": true}` | Proxy settings for more reliable collection |

If both `startUrl` and `state` are provided, the explicit `startUrl` is used.

---

## Output Data

Each dataset item can contain the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Agent identifier used in the result data |
| `agentIdV2` | String | Secondary agent identifier |
| `agencyId` | Number | Agency identifier |
| `url` | String | Full Domain.com.au agent profile URL |
| `profileSlug` | String | Agent profile slug |
| `name` | String | Full agent name |
| `firstName` | String | First name |
| `lastName` | String | Last name |
| `title` | String | Job title when available |
| `agency` | String | Agency name |
| `agencyUrl` | String | Agency profile URL when available |
| `phone` | String | Office phone number |
| `mobile` | String | Mobile phone number |
| `hasEmail` | Boolean | Whether the profile indicates email availability |
| `profileTier` | String | Profile level shown in results |
| `profileImage` | String | Agent profile image URL |
| `agencyLogo` | String | Agency logo URL |
| `brandColour` | String | Agency or profile brand color |
| `averageSoldPrice` | Number | Average sold price |
| `averageSoldDaysOnMarket` | Number | Average days on market |
| `propertiesForSale` | Number | Current sale listings count |
| `propertiesForRent` | Number | Current rental listings count |
| `propertiesSold` | Number | Sold or auctioned properties count |
| `totalSoldAndAuctioned` | Number | Total sold and auctioned count |
| `totalJointSoldAndAuctioned` | Number | Joint sold and auctioned count |
| `totalLeased` | Number | Total leased count |
| `totalJointLeased` | Number | Joint leased count |
| `rating` | Number | Overall review rating |
| `reviewCount` | Number | Total review count |
| `recentRating` | Number | Recent review rating when available |
| `recentReviewCount` | Number | Recent review count when available |
| `source` | String | Source website |
| `scrapedAt` | String | ISO timestamp of collection |

---

## Usage Examples

### Basic Search

Collect agents from a known search page:

```json
{
  "startUrl": "https://www.domain.com.au/real-estate-agents/sydney-nsw-2000/",
  "maxResults": 20,
  "maxPages": 3
}
```

### State-Based Search

Use a state shortcut and let the actor build a capital-city search:

```json
{
  "state": "vic",
  "maxResults": 50,
  "maxPages": 5
}
```

### Focused Collection

Collect a larger set for a filtered search:

```json
{
  "startUrl": "https://www.domain.com.au/real-estate-agents/sydney-nsw-2000/",
  "specialization": "commercial",
  "maxResults": 100,
  "maxPages": 10,
  "proxyConfiguration": {
    "useApifyProxy": true
  }
}
```

---

## Sample Output

```json
{
  "id": "900362",
  "agentIdV2": "A31461",
  "agencyId": 6877,
  "url": "https://www.domain.com.au/real-estate-agent/bryn-fowler-900362/",
  "profileSlug": "bryn-fowler-900362",
  "name": "Bryn Fowler",
  "firstName": "Bryn",
  "lastName": "Fowler",
  "agency": "Sydney Cove Property",
  "phone": "02 8259 3333",
  "mobile": "0423 663 663",
  "hasEmail": true,
  "profileTier": "platinum",
  "brandColour": "#7da3c4",
  "averageSoldPrice": 1151518.5185185184,
  "averageSoldDaysOnMarket": 59.88461538461539,
  "propertiesForSale": 18,
  "propertiesForRent": 0,
  "propertiesSold": 28,
  "totalSoldAndAuctioned": 28,
  "totalJointSoldAndAuctioned": 33,
  "totalLeased": 0,
  "totalJointLeased": 0,
  "rating": 5,
  "reviewCount": 7,
  "recentReviewCount": 0,
  "source": "https://www.domain.com.au",
  "scrapedAt": "2026-05-03T11:59:15.212Z"
}
```

---

## Tips for Best Results

### Start With Working Search URLs

- Use complete Domain.com.au agent-search URLs that already include suburb, state, and postcode
- Test with `maxResults: 20` before scaling up

### Use Proxies For Better Stability

- Residential proxies improve reliability on protected pages
- Local runs without a configured Apify proxy token may behave differently than Apify platform runs

### Scale Gradually

- Increase `maxPages` only when needed
- Start with a narrow suburb search before broader collection

---

## Integrations

Connect the dataset with:

- **Google Sheets** — Build searchable lead lists
- **Airtable** — Store and filter agent records
- **Make** — Automate downstream enrichment
- **Zapier** — Trigger notifications and workflows
- **Webhooks** — Send data into custom systems

### Export Formats

- **JSON** — For applications and APIs
- **CSV** — For spreadsheets and imports
- **Excel** — For reporting and analysis
- **XML** — For system integrations

---

## Frequently Asked Questions

### How many agents can I collect?

You can collect up to the result count exposed by the search pages, subject to your `maxResults` and `maxPages` settings.

### Does the actor remove duplicates?

Yes. Records are deduplicated before they are saved to the dataset.

### Why are some fields missing from some records?

Some agents do not expose every field on the source page. The actor keeps the output clean by omitting empty values instead of filling them with nulls.

### Do I need proxies?

Proxies are recommended for reliable collection, especially at larger scale or during repeated runs.

### Can I use a state instead of a full URL?

Yes. You can provide `state` to build a location-based search automatically.

---

## Support

For issues or feature requests, use the Apify Console project support flow.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Scheduling Runs](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is intended for legitimate data collection, research, and business workflow use. You are responsible for reviewing the target website terms and for using the collected data in compliance with applicable laws and platform policies.
