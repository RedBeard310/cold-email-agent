# Consulti.ai API

> Lead enrichment, email verification, and B2B/local/creator database search. REST + MCP.
> Auth key: `CONSULTI_API_KEY` in `/Users/caseybrown/Claude/env-storage/.env` (starts with `capi_`).
> Verified working 2026-07-10 via `GET /credits` (balance at that time: 16,000 lead credits / 11,000 verification credits).

Base URL: https://www.consulti.ai/api/v1
Documentation: https://www.consulti.ai/api-docs
API keys: https://www.consulti.ai/settings?tab=integrations#api-keys

## Authentication

All endpoints require a Bearer token in the Authorization header:

    Authorization: Bearer capi_your_api_key

API keys start with "capi_" and are generated in Settings → Integrations.

## Access tiers

- Email verification works on any plan.
- All other endpoints require the Pro plan or higher.

## Endpoints

### POST /verify
Verify whether an email address is valid and deliverable. Leading/trailing whitespace in `email` is trimmed automatically before validation.
Credits: Only successful verifications are billed — 1 verification credit each. Failed validation (400), auth (401), and insufficient-credit (402) responses are never billed and return credits_used: 0. Cache-served results cost the same as fresh.
Request: `{ "email": "john@acme.com" }`
Response: `{ "success": true, "data": { "email", "status" (good|risky|bad|unknown), "is_deliverable", "is_disposable", "is_role_account", "is_catch_all", "credits_used" } }`

Routing guide — use the boolean flags alongside the status field to route follow-ups:
- is_catch_all=true → route to LinkedIn enrichment (SMTP cannot verify catch-all mailboxes)
- is_role_account=true → deprioritise (info@, support@, sales@ usually low reply rates)
- is_disposable=true → drop (10minutemail, mailinator, etc.)
- status=unknown → retry later (transient upstream issue, not a permanent verdict)

### POST /verify/catchall
Resolve whether a specific mailbox on a catch-all domain actually exists. Use it on addresses /verify reports as is_catch_all=true — SMTP cannot resolve those, this endpoint can (it probes mailbox existence via Consulti's ESP verification engine, with an automatic fallback for providers the engine doesn't cover).
Requires a plan with catch-all verification enabled (Pro or higher); returns 402 when the plan isn't entitled. Leading/trailing whitespace in `email` is trimmed automatically before validation.
Credits: Only successful verifications are billed — 5 verification credits each. Failed validation (400), auth (401), and insufficient-credit (402) responses are never billed and return credits_used: 0. Cache-served results cost the same as fresh.
Request: `{ "email": "john@catchall-domain.com" }`
Response: `{ "success": true, "data": { "email", "status" (good|risky|bad|unknown), "is_catch_all": true, "catch_all_verification": { "score" (0–100), "status" (Deliverable|Catch-All|Undeliverable|Unknown), "provider": "consulti" }, "credits_used": 5, "cached" } }`

### POST /leads/find-by-name
Find a B2B lead by first name, last name, and company domain.
Credits: 1 lead credit — only deducted on a successful match.
Request: `{ "first_name": "John", "last_name": "Doe", "domain": "acme.com" }`
Response: `{ "success": true, "data": { email, first_name, last_name, job_title, company_name, company_domain, industry, linkedin_url, city, state, country, employee_count, technologies (string[] of Wappalyzer-style names the company's website uses, or null), mobile_phone (personal mobile or null), company_phone (company line or null), email_status (valid|risky|invalid|unknown|unverified), verified_at }, "credits_used": 1 }`

### POST /leads/enrich
Enrich a B2B lead by email.
Credits: 1 lead credit — only deducted on a successful match.
Request: `{ "email": "john@acme.com" }`
Response: same shape as /leads/find-by-name

### POST /enrich/linkedin
Enrich a person by their LinkedIn profile URL → a verified work email plus their US mobile phone (free add-on). Cache-first: served from our database when we already hold a verified email, otherwise enriched live via the provider and cached.
Credits: 1 lead credit — charged only when an email is returned. Phone is a free add-on; phone-only or no-email responses are free.
Request: `{ "linkedin_url": "https://linkedin.com/in/johndoe" }`
Response: `{ "success": true, "source": "cache"|"blitz", "credits_used": 1, "data": { email, email_status (valid|risky|invalid|unknown|unverified — cache hits surface the stored verification verdict; live (Blitz) responses currently return "unknown" until the live result is re-verified), phone (US mobile or null), company_domain, person_linkedin_url, and on a cache hit also first_name, last_name, full_name, job_title, company_name, company_linkedin_url, industry, city, state, country } }`

### POST /leads/search
Search 500M+ B2B leads. Always restricted to leads with our verified email label (the verified-only filter is forced on; there is no option to include unverified leads).
Credits: 1 lead credit per result returned. Reserved up to `size`, then refunded down to the actual row count. 0 results = 0 credits.
Request (all fields optional): `{ "q", "titles": string[], "industries": string[], "technologies": string[] (website tech, exact Wappalyzer-style names e.g. ["Shopify"], OR-matched, max 25 — GET /api/v1/meta/technologies for the canonical list), "excludeTechnologies": string[] (drop leads whose company uses ANY listed technology; leads with no technology data are kept; max 25), "countries": string[], "states": string[], "cities": string[], "company", "empMin": number, "empMax": number, "page": number, "size": number (max 100) }`
Response: `{ "leads": [{ first_name, last_name, email, job_title, company_name, company_domain, linkedin_url, city, state, country, employees, industry, technologies (string[] or null), mobile_phone (or null), company_phone (or null), email_status }], "total", "page", "size" }`

### POST /local-leads/search
Search 5M+ local businesses from Google Maps. Always restricted to businesses with a verified email (the verified-only filter is forced on).
Credits: 1 lead credit per result returned. Reserved up to `size`, then refunded down to the actual row count. 0 results = 0 credits.
Request (all fields optional): `{ "q", "name", "keywords": string[], "states": string[], "cities": string[], "zips": string[], "ratingMin", "ratingMax", "reviewsMin", "reviewsMax", "hasWeb": boolean, "hasPhone": boolean, "page", "size" }`
Response: `{ "businesses": [{ id, name, phone, website, email, address, city, state, zip, rating, reviews, category }], "total", "page", "size" }`

### POST /creator-leads/search
Search 2.6M+ podcasts and 62K+ YouTube channels. Always restricted to creators with a verified email: podcasts to a verified (non-catch-all) status, YouTube channels to those with a valid, non-catch-all verification verdict. The verified-only filter is forced on (catch-all and invalid emails are never returned).
Credits: 1 lead credit per result returned. Reserved up to `size`, then refunded down to the actual row count. 0 results = 0 credits.
Request: `{ "source": "youtube" | "podcast" (required), "q", "categories": string[], "niches": string[], "country", "language", "minSubscribers", "maxSubscribers", "minEpisodes", "page", "size" }`
Response: `{ "creators": [{ id, name, email, source, niche|category, country, subscribers|episodes, website }], "total", "page", "size" }`

### GET /lists
Return saved lead lists for the authenticated user with member counts.
Credits: free.
Response: `{ "lists": [{ id, name, description, created_at, member_count }] }`

### POST /lists
Create a saved lead list.
Credits: free.
Request: `{ "name": "My List" (required), "description": "Optional" }`
Response: `{ "list": { id, name, description, created_at } }`

### POST /lists/{id}/add-leads
Add leads to a saved list by email (B2B) or business ID (local). Duplicates ignored.
Credits: free.
Request (one of): `{ "emails": ["a@b.com", ...] }` OR `{ "businessIds": [123, 456, ...] }`
Response: `{ "added": number, "skipped": number }`

### GET /credits
Return the authenticated API user's current lead and verification credit balances. Pre-flight check before running large batches.
Credits: free — no deduction.
Request: none (GET with Bearer auth)
Response: `{ "success": true, "data": { "lead_credits": number, "verification_credits": number } }`

### GET /meta/{filter}
Return the canonical list of values accepted by a given enum filter. No auth required. Snapshot-first with a 1-hour edge cache that revalidates against the live database.
Filters: industries, countries, states, email-statuses, technologies, local-states, creator-podcast-categories, creator-youtube-niches, creator-languages, creator-countries.
The technologies filter is non-strict (values outside the list still filter) and its response also includes "entries": [{ name, category }] for category grouping.
Special slug "_all" returns every filter at once (snapshot-only).
Credits: free.
Response: `{ "filter", "canonical_filter", "source": "live"|"snapshot", "count", "generated_at", "values": string[] }`
Response (_all): `{ "filters": { "<slug>": { "canonical_filter", "count", "values": string[], "generated_at" } } }`

## Error codes

- 401 — Missing or invalid API key.
- 402 — Insufficient credits.
- 403 — Plan doesn't have access (Pro required for lead endpoints).
- 404 — No match (no credits charged).
- 429 — Rate limited. Retry with exponential backoff.
- 500 — Server error.

All errors return: `{ "error": "message" }`

## MCP Server

Consulti.ai publishes an MCP server that exposes its stable endpoints as tools for Claude Desktop, Cursor, and other MCP clients. (Beta endpoints are REST-only and not exposed via MCP.)

Install: `npx consulti-mcp`

Claude Desktop config:

    {
      "mcpServers": {
        "consulti": {
          "command": "npx",
          "args": ["-y", "consulti-mcp"],
          "env": { "CONSULTI_API_KEY": "capi_your_api_key" }
        }
      }
    }

Available tools:
- verify_email
- verify_catchall
- enrich_lead
- enrich_linkedin
- search_b2b_leads
- get_lists
- create_list
- add_leads_to_list
- get_credits

## Canonical filter values

Enum filter values are NOT inlined here — fetch them live (free, no auth):

    GET https://www.consulti.ai/api/v1/meta/{filter}
    GET https://www.consulti.ai/api/v1/meta/_all

Filter slugs: industries (145), countries (192 — note: contains some US state names mixed in), states (877), email-statuses (bad, good, invalid, risky, unknown, valid), technologies (7,538 — non-strict, Wappalyzer-style names like "Shopify", "WordPress", "HubSpot"), local-states (58 US/CA two-letter codes), local-email-statuses (risky, safe), creator-podcast-categories (243), creator-podcast-email-statuses (catch_all, invalid, unknown, valid), creator-youtube-niches (361 — includes e.g. "financial", "wealth", "investing", "retirement"-adjacent terms), creator-languages (31), creator-countries (66), instagram-categories (250), instagram-account-types (business, personal, public, private), instagram-email-statuses (bad, catch_all, good, risky).

Caveat: the countries list has known data-quality noise (US state names like "California" and "Texas" appear as countries, plus duplicate spellings like "Czechia"/"Czech Republic" and a literal "REVIEW_REQUIRED" value) — when filtering by US location, pass both `"countries": ["United States"]` and the relevant `states` to be safe.
