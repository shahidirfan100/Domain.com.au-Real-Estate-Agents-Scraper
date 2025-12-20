# Domain.com.au Real Estate Agents Scraper

<p>Comprehensive Australian real estate agent data extraction tool for Domain.com.au. Efficiently scrape agent profiles, agency information, contact details, performance metrics, and specialization data with advanced automation capabilities.</p>

## What does Domain.com.au Real Estate Agents Scraper do?

<p>This powerful scraper extracts detailed real estate agent information from Australia's leading real estate platform, Domain.com.au. It collects comprehensive data including agent profiles, agency details, contact information, areas of operation, specializations, and performance data.</p>

<h3>Key Features</h3>

<ul>
  <li><strong>Multi-Method Extraction</strong> - Combines JSON-LD parsing and HTML extraction for maximum data quality</li>
  <li><strong>Intelligent Fallback</strong> - Automatically switches between extraction methods to ensure reliable data collection</li>
  <li><strong>Comprehensive Data</strong> - Captures agent names, agency info, contact details, specializations, and performance metrics</li>
  <li><strong>Advanced Filtering</strong> - Search by location, suburb, state, agency name, and agent specialization</li>
  <li><strong>Smart Pagination</strong> - Handles multiple result pages automatically with configurable limits</li>
  <li><strong>Detail Collection</strong> - Optional deep scraping of individual agent profile pages for complete information</li>
  <li><strong>Rate Limiting</strong> - Built-in delays and concurrency control to ensure stable operation</li>
  <li><strong>Proxy Support</strong> - Residential proxy integration for reliable access</li>
</ul>

## Why choose this scraper?

<ul>
  <li>✅ <strong>Production Ready</strong> - Tested and optimized for reliability</li>
  <li>✅ <strong>High Performance</strong> - Efficient extraction with minimal resource usage</li>
  <li>✅ <strong>Quality Data</strong> - Structured output with comprehensive agent information</li>
  <li>✅ <strong>Easy Configuration</strong> - Simple input schema with sensible defaults</li>
  <li>✅ <strong>Cost Effective</strong> - Optimized to minimize compute units and proxy usage</li>
  <li>✅ <strong>Maintained</strong> - Regular updates to adapt to website changes</li>
</ul>

## Input Configuration

<p>Configure the scraper using these parameters to customize your data extraction:</p>

<table>
  <thead>
    <tr>
      <th>Parameter</th>
      <th>Type</th>
      <th>Description</th>
      <th>Default</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>startUrl</code></td>
      <td>String</td>
      <td>Domain.com.au real estate agents search URL to begin scraping from</td>
      <td>All Australian real estate agents</td>
    </tr>
    <tr>
      <td><code>location</code></td>
      <td>String</td>
      <td>Specific location to search (e.g., 'sydney-nsw', 'melbourne-vic')</td>
      <td>null</td>
    </tr>
    <tr>
      <td><code>suburb</code></td>
      <td>String</td>
      <td>Specific suburb to filter agents by area of operation</td>
      <td>null</td>
    </tr>
    <tr>
      <td><code>state</code></td>
      <td>String</td>
      <td>Australian state code (nsw, vic, qld, wa, sa, tas, act, nt)</td>
      <td>null</td>
    </tr>
    <tr>
      <td><code>agencyName</code></td>
      <td>String</td>
      <td>Filter by specific agency name</td>
      <td>null</td>
    </tr>
    <tr>
      <td><code>specialization</code></td>
      <td>String</td>
      <td>Filter by specialization: residential, commercial, rural, etc.</td>
      <td>null (all types)</td>
    </tr>
    <tr>
      <td><code>collectDetails</code></td>
      <td>Boolean</td>
      <td>Visit each agent profile page for complete details (slower but comprehensive)</td>
      <td>true</td>
    </tr>
    <tr>
      <td><code>maxResults</code></td>
      <td>Integer</td>
      <td>Maximum number of agents to extract (1-1000)</td>
      <td>50</td>
    </tr>
    <tr>
      <td><code>maxPages</code></td>
      <td>Integer</td>
      <td>Maximum number of result pages to process (1-50)</td>
      <td>3</td>
    </tr>
    <tr>
      <td><code>maxConcurrency</code></td>
      <td>Integer</td>
      <td>Concurrent requests for detail collection (1-10)</td>
      <td>3</td>
    </tr>
    <tr>
      <td><code>proxyConfiguration</code></td>
      <td>Object</td>
      <td>Proxy settings (residential proxies recommended)</td>
      <td>Apify residential proxy</td>
    </tr>
  </tbody>
</table>

## Output Data

<p>Each real estate agent profile includes the following structured data:</p>

<h3>Core Information</h3>
<ul>
  <li><code>id</code> - Unique agent identifier</li>
  <li><code>url</code> - Direct link to the agent profile</li>
  <li><code>name</code> - Agent's full name</li>
  <li><code>title</code> - Professional title (e.g., Sales Agent, Principal)</li>
  <li><code>agency</code> - Real estate agency name</li>
  <li><code>agencyUrl</code> - Link to agency profile</li>
</ul>

<h3>Contact Information</h3>
<ul>
  <li><code>phone</code> - Primary phone number</li>
  <li><code>mobile</code> - Mobile phone number</li>
  <li><code>email</code> - Email address</li>
  <li><code>officeAddress</code> - Physical office location</li>
  <li><code>suburb</code> - Office suburb/locality</li>
  <li><code>state</code> - Australian state</li>
  <li><code>postcode</code> - Postal code</li>
</ul>

<h3>Professional Details</h3>
<ul>
  <li><code>specializations</code> - Areas of expertise (residential, commercial, etc.)</li>
  <li><code>languages</code> - Languages spoken</li>
  <li><code>servicesOffered</code> - Types of services provided</li>
  <li><code>areasServed</code> - Geographic areas covered</li>
  <li><code>yearsExperience</code> - Years in the industry</li>
</ul>

<h3>Performance Metrics</h3>
<ul>
  <li><code>currentListings</code> - Number of active listings</li>
  <li><code>soldProperties</code> - Recently sold properties count</li>
  <li><code>rentedProperties</code> - Recently rented properties count</li>
  <li><code>rating</code> - Agent rating/reviews</li>
  <li><code>reviewCount</code> - Number of reviews</li>
</ul>

<h3>Media & Presentation</h3>
<ul>
  <li><code>profileImage</code> - Agent profile photo URL</li>
  <li><code>agencyLogo</code> - Agency logo URL</li>
  <li><code>biography</code> - Professional biography</li>
  <li><code>description</code> - Profile description</li>
</ul>

<h3>Metadata</h3>
<ul>
  <li><code>scrapedAt</code> - Timestamp of data collection</li>
  <li><code>source</code> - Data source identifier</li>
</ul>

## Usage Examples

<h3>Example 1: Search Sydney Agents</h3>

<pre><code>{
  "location": "sydney-nsw",
  "specialization": "residential",
  "maxResults": 100,
  "collectDetails": true
}</code></pre>

<p>This configuration searches for residential real estate agents in Sydney, NSW.</p>

<h3>Example 2: Melbourne Commercial Agents</h3>

<pre><code>{
  "state": "vic",
  "location": "melbourne-vic",
  "specialization": "commercial",
  "maxResults": 50,
  "collectDetails": true
}</code></pre>

<p>Extracts commercial real estate agents operating in Melbourne, Victoria.</p>

<h3>Example 3: Specific Agency Agents</h3>

<pre><code>{
  "agencyName": "Ray White",
  "state": "qld",
  "maxResults": 30,
  "collectDetails": true
}</code></pre>

<p>Scrapes agents from Ray White agency in Queensland.</p>

<h3>Example 4: Custom URL Search</h3>

<pre><code>{
  "startUrl": "https://www.domain.com.au/real-estate-agents/sydney-nsw/",
  "maxResults": 200,
  "maxPages": 10,
  "collectDetails": true
}</code></pre>

<p>Uses a specific Domain.com.au URL to scrape agents with deep detail collection.</p>

## How to Use

<ol>
  <li><strong>Configure Input</strong> - Set your search parameters in the input schema</li>
  <li><strong>Set Proxy</strong> - Use residential proxies for best results (included in default configuration)</li>
  <li><strong>Run Scraper</strong> - Start the actor and monitor progress in real-time</li>
  <li><strong>Export Data</strong> - Download results in JSON, CSV, Excel, or other formats</li>
</ol>

<h3>Quick Start</h3>

<p>The simplest way to get started is using the default configuration, which will scrape real estate agents across Australia:</p>

<pre><code>{
  "maxResults": 50,
  "collectDetails": true
}</code></pre>

<p>This collects 50 agent profiles with full details - perfect for testing.</p>

## Performance & Best Practices

<h3>Performance Tips</h3>

<ul>
  <li><strong>Disable Detail Collection</strong> - Set <code>collectDetails</code> to <code>false</code> for faster extraction of basic agent data</li>
  <li><strong>Adjust Concurrency</strong> - Increase <code>maxConcurrency</code> to 5-7 for faster detail collection (requires more proxy IPs)</li>
  <li><strong>Limit Pages</strong> - Set realistic <code>maxPages</code> values to control runtime and costs</li>
  <li><strong>Use Filters</strong> - Apply location and specialization filters to reduce irrelevant results</li>
</ul>

<h3>Cost Optimization</h3>

<ul>
  <li>Basic agent scraping (without details): ~0.01-0.02 compute units per agent</li>
  <li>Full detail collection: ~0.05-0.08 compute units per agent</li>
  <li>Use datacenter proxies for testing, residential proxies for production</li>
  <li>Process agents in batches to optimize resource usage</li>
</ul>

<h3>Reliability Tips</h3>

<ul>
  <li><strong>Always Use Proxies</strong> - Residential proxies recommended for consistent access</li>
  <li><strong>Respect Rate Limits</strong> - Keep <code>maxConcurrency</code> at 3-5 for stable operation</li>
  <li><strong>Monitor Results</strong> - Check logs for any extraction issues</li>
  <li><strong>Handle Errors</strong> - The scraper includes automatic retries for failed requests</li>
</ul>

## Integration & Export

<h3>Output Formats</h3>

<p>Export your scraped data in multiple formats:</p>

<ul>
  <li><strong>JSON</strong> - Structured data with full hierarchy</li>
  <li><strong>CSV</strong> - Flat format for spreadsheet applications</li>
  <li><strong>Excel</strong> - Formatted workbook with data</li>
  <li><strong>XML</strong> - Structured markup format</li>
  <li><strong>RSS</strong> - Feed format for monitoring</li>
</ul>

<h3>API Integration</h3>

<p>Access scraped data programmatically using the Apify API:</p>

<pre><code>https://api.apify.com/v2/acts/YOUR-ACTOR-ID/runs/last/dataset/items</code></pre>

<h3>Webhooks</h3>

<p>Set up webhooks to receive notifications when scraping completes or trigger downstream processes automatically.</p>

## Use Cases

<h3>Real Estate Professionals</h3>
<ul>
  <li>Build comprehensive agent databases</li>
  <li>Competitive intelligence and market analysis</li>
  <li>Recruitment and talent acquisition</li>
  <li>Partnership and collaboration opportunities</li>
</ul>

<h3>Business Development</h3>
<ul>
  <li>Lead generation for B2B services</li>
  <li>Market research and targeting</li>
  <li>CRM database enrichment</li>
  <li>Network building and outreach</li>
</ul>

<h3>Data Analysts & Researchers</h3>
<ul>
  <li>Real estate industry research</li>
  <li>Agent performance analysis</li>
  <li>Market coverage studies</li>
  <li>Competitive landscape mapping</li>
</ul>

<h3>Marketing & Sales Teams</h3>
<ul>
  <li>Targeted marketing campaigns</li>
  <li>Sales prospecting</li>
  <li>Industry contact lists</li>
  <li>Market segmentation</li>
</ul>

## Technical Details

<h3>Extraction Methods</h3>

<p>The scraper employs multiple extraction techniques for maximum reliability:</p>

<ul>
  <li><strong>JSON-LD Parsing</strong> - Extracts structured data from JSON-LD schema markup (highest quality)</li>
  <li><strong>HTML Parsing</strong> - Cheerio-based extraction from HTML elements (fast and efficient)</li>
  <li><strong>Playwright Fallback</strong> - Browser automation for JavaScript-rendered content (most reliable)</li>
</ul>

<h3>Smart Features</h3>

<ul>
  <li><strong>Automatic Deduplication</strong> - Prevents duplicate agent entries</li>
  <li><strong>Intelligent Pagination</strong> - Automatically follows next page links</li>
  <li><strong>Error Recovery</strong> - Automatic retries with exponential backoff</li>
  <li><strong>Rate Limiting</strong> - Built-in delays to prevent blocking</li>
</ul>

<h3>Data Quality</h3>

<ul>
  <li>Validates and normalizes all extracted data</li>
  <li>Handles missing or incomplete information gracefully</li>
  <li>Preserves data relationships and hierarchies</li>
  <li>Includes metadata for tracking and debugging</li>
</ul>

## Frequently Asked Questions

<h3>How many agents can I scrape?</h3>
<p>You can scrape up to 1000 agents per run. For larger datasets, run the scraper multiple times with different search criteria or increase the <code>maxPages</code> parameter.</p>

<h3>Do I need proxies?</h3>
<p>Yes, proxies are highly recommended. The default configuration uses Apify residential proxies, which provide the best reliability. Domain.com.au may block requests from datacenter IPs or rate-limit repeated requests.</p>

<h3>How long does scraping take?</h3>
<p>Without detail collection: ~1-2 seconds per agent. With full details: ~3-5 seconds per agent. Total runtime depends on <code>maxResults</code>, <code>maxPages</code>, and <code>collectDetails</code> settings.</p>

<h3>What if the scraper stops working?</h3>
<p>Website structures change over time. If you encounter issues, please report them and a fix will be deployed promptly. The scraper is regularly updated to maintain compatibility.</p>

<h3>Can I filter by specific agency?</h3>
<p>Yes, use the <code>agencyName</code> parameter to filter agents by their agency affiliation.</p>

<h3>Is this legal?</h3>
<p>Web scraping publicly available data is generally legal. However, always review Domain.com.au's terms of service and robots.txt. Use responsibly and respect rate limits. This tool is intended for business research and analysis.</p>

<h3>How much does it cost?</h3>
<p>Cost depends on usage. Approximate costs: Basic scraping (50 agents, no details): ~$0.10-0.20. Full detail collection (50 agents): ~$0.40-0.60. Costs include compute units and proxy usage.</p>

## Support & Updates

<p>This scraper is actively maintained and regularly updated to ensure compatibility with Domain.com.au. For support, feature requests, or bug reports, please contact through the Apify platform.</p>

<h3>Version History</h3>
<ul>
  <li><strong>1.0.0</strong> - Initial release with comprehensive feature set</li>
</ul>

## Compliance & Ethics

<p>This tool is designed for legitimate use cases such as market research, business development, and data aggregation. Users are responsible for:</p>

<ul>
  <li>Complying with Domain.com.au's terms of service</li>
  <li>Respecting robots.txt directives</li>
  <li>Using reasonable rate limits</li>
  <li>Not overloading servers</li>
  <li>Handling personal data responsibly</li>
  <li>Following applicable data protection regulations (including GDPR and Australian Privacy Act)</li>
</ul>

<p>Always use web scraping tools responsibly and ethically.</p>

---

<p><em>Disclaimer: This scraper is an independent tool and is not affiliated with, endorsed by, or connected to Domain.com.au or its parent companies. All trademarks and brand names are properties of their respective owners.</em></p>
