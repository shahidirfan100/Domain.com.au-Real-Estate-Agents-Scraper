## Selected API
- Endpoint: `#__NEXT_DATA__` -> `props.pageProps.__APOLLO_STATE__.ROOT_QUERY["contactSearchBySuburbs(...)"]`
- Method: `GET`
- Auth: None, but direct HTTP requests are challenged by Akamai
- Pagination: `page` query parameter on the search URL; Apollo cache exposes `pageNumber`, `totalPages`, and `total`
- Fields available: `id`, `agentIdV2`, `agencyId`, `name`, `jobTitle`, `telephone`, `mobile`, `hasEmail`, `profileTier`, `profileUrl`, `profilePhoto`, `agencyName`, `agencyLogoUrl`, `brandColour`, `totalForSale`, `averageSoldPrice`, `averageSoldDaysOnMarket`, `totalSoldAndAuctioned`, `totalJointSoldAndAuctioned`, `totalForRent`, `totalLeased`, `totalJointLeased`, `reputation.numberOfReviews`, `reputation.overallStarRating`, `reputation.overallStarRatingRecent`, `reputation.numberOfReviewsRecent`
- Fields currently missing in actor: `agentIdV2`, `agencyId`, `profileTier`, `brandColour`, `totalJointSoldAndAuctioned`, `totalLeased`, `totalJointLeased`, `recentRating`, `recentReviewCount`
- Field count: 26+ available fields vs the previous HTML fallback path, which was only reliably producing a small subset and often zero records

## Rejected Candidates
- `urlscan.io` public search: no exact current scan for the target agent-result URL, so it did not produce a usable endpoint for this page
- Direct page HTML over `gotScraping`: returned an Akamai challenge page instead of the search results
- Guessed `/_next/data/...` route over direct HTTP: returned `404` and was not a stable standalone endpoint
- HTML card parsing: brittle and already failing in production with empty extraction

## Runtime Decision
- No stable public JSON or `_next/data` endpoint was exposed for direct replay
- The fastest reliable implementation is HTTP-first page fetching with a sticky proxy session and cookie jar, then extraction from the embedded Apollo payload
- Firefox remains only as a narrow fallback when a page returns an Akamai challenge instead of usable HTML
- This removes the per-page browser cost while keeping extraction aligned to the live data model
