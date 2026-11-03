# CEB Electricity Bill Fetcher (Google Apps Script)

Automated multi-account scraper and cache engine for Mauritius Central Electricity Board (CEB) bills from `https://payment.ceb.mu/`.

## Features
- **100% Google Drive-Free**: In-memory RAM `CacheService` + `PropertiesService`.
- **Multi-Account Support**: Scrapes multiple electricity accounts and produces an aggregated summary.
- **Sub-15ms API Response**: Cached JSON responses served via Web App endpoint.
- **Configurable**: Set `CEB_ACCOUNTS` in Script Properties as a comma-separated list of Contract Account numbers.
- **Integrated with Home Assistant & Cloudflare MRU Gateway**.

