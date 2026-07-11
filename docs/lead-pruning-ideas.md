# Lead-pruning ideas — ICP-fit checks beyond the basic clean

The master list of ways to verify loaded leads actually fit the ICP (high-ticket, trust-based
service businesses that benefit from YouTube authority content), ranked by cost. Statuses
reflect Casey's 2026-07-10 review. The runnable checks live in `src/consulti/prune.ts`
(`consulti:prune` CLI); `src/consulti/clean.ts` owns the pre-load stages (dup/title/blocklist/
foreign-TLD/dead-site).

**Hard rule that applies to every check:** freemail leads (gmail etc.) are NEVER rejected —
owners' personal inboxes can be top performers. Freemail hosts are exempt from all
domain-level grouping and homepage judgment.

## ✅ Implemented (in `consulti:prune`)

| Check | Disposition | Notes |
|---|---|---|
| Role-based emails (`info@`, `office@`, `appointments@`…) | remove | Gatekeeper inboxes; ZeroBounce marks them do_not_mail anyway — removing early saves verification credits |
| Disposable email domains | remove | mailinator etc. |
| One contact per company domain | remove extras | Partners at the same firm compare notes; keeps the strongest title (owner/founder > president/principal > rest). BD-shared domains and `segment=bd_affiliated` advisor rows are exempt. **Advisors niche: check is OFF entirely** (Casey, 2026-07-10) — the offer is a per-advisor channel and the mid-size RIA thesis wants several advisors per firm: "the more shots you take, the more baskets you can sink" |
| Cross-niche email collision | remove from later base | Same person loaded into two niche bases would get two different pitches |
| Cross-niche domain collision | flag | Different people at the same company in two bases — human call |
| Parked / for-sale domains | remove | Responds 200 so the dead-site check passes it; content pass reads the page |
| Placeholder sites ("coming soon") | flag | Business is probably real, just web-less — possibly *great* targets for a presence-building offer |
| Homepage niche-keyword scan | flag | Site loads real text but zero niche-relevant words → likely off-vertical. ~50% precision, so flags get a human (or Claude) review before deletion — the 2026-07-10 pass caught zoos, marinas, electricians, and ministries |
| Broken first names (blank / non-name) | flag | Personalization would look broken |
| First-name ↔ email mismatch | fix | Lead says "Michael" but the inbox is `samantha@…` → bad data. The email is ground truth (it's whose inbox we land in), so first_name is corrected to match the inbox owner rather than deleting the lead. Nickname-aware (Mike/Michael, Bill/William…), dictionary-confirmed before touching anything |

Ops rule (learned 2026-07-10): homepage/site checks at concurrency ≤ 20, and treat any
dead/parked spike far above ~8% as environmental (local network exhaustion) until spot-verified.

## 👍 Approved by Casey — build next

- **Ads-transparency check (Meta Ad Library + Google Ads Transparency Center).** A firm
  already paying for ads has marketing budget and believes in marketing — arguably the
  strongest free "will buy" signal. Meta's library is queryable by page/company name; Google's
  center by advertiser. Fuzzy name-matching is the hard part.
- **Google reviews count (Places API).** Separates real practices with local presence from
  hobby operations. ~$0.017/lookup (Text Search) — ~$170 per 10k leads, or scrape-free via
  the Places details on a matched place_id. Also yields rating + review velocity.
- **YouTube channel check (Casey: "the most ingenious — it gives us an angle").** Search
  YouTube Data API for the company/owner name. For the *sell-YouTube* offer this cuts both
  ways and both are useful: no channel = the core pitch fits; existing-but-dead channel
  ("3 videos, 2 years ago") = an even hotter segment — they already believe in YouTube, they
  just failed at it, and the copy can say so. API quota: search = 100 units, 10k units/day
  free → ~100 lookups/day, so either trickle it over days, request a quota bump, or match via
  site-embedded channel links scraped during the homepage pass (free, catches the strongest
  signal anyway: a channel they link from their own site).

## ⛔ Skipped (Casey's call, 2026-07-10)

- **MX-record check** — skipped; ZeroBounce covers undeliverable domains at verify time anyway.

## 💸 Expensive / time-consuming backlog (the "full range")

- **LLM review of every homepage** — an agent reads each site, scores ICP fit 0–10, and
  writes a personalized first line while it's there. What Clay charges $$$/mo for. Best
  absolute outcome; hours of agent time + real token spend per 10k leads. Natural fit for a
  Claude workflow fan-out if/when wanted.
- **License-registry cross-checks** — state bar rolls (legal), CPA license boards
  (accounting), NPI registry (health). Definitive "real practicing professional," same idea
  as the SEC/IAPD verification the advisors pipeline already does upstream. Slow: 50 states,
  inconsistent search interfaces.
- **LinkedIn enrichment** (Proxycurl-style, ~$0.01–0.10/lead) — verifies the title is
  *current*; database titles go stale fast.
- **Tech-stack detection** (BuiltWith/Wappalyzer) — booking systems/CRMs = operationally
  mature enough to handle inbound volume.
- **Hiring-signal scan** (job postings) — hiring = growth = budget.
- **Phone validation** (Twilio Lookup) — only matters if a calling/SMS channel is added.
- **Intent data** (Bombora et al.) — enterprise pricing; overkill at this deal size.
- **Human VA review pass** — the classic; benchmark any automated pass against it.

## Run log

- **2026-07-10** — four new niche bases pruned: 425 removed (387 dup-domain, 30
  homepage-verified off-vertical, 7 parked, 1 role-email) → legal 2,592 · accounting 2,521 ·
  health 2,547 · consulting 2,539. Archives: `consulti-pruned-2026-07-10.csv`; unresolved
  flags: `consulti-review-2026-07-10.csv`. Plus 23 first-name fixes across the four bases.
- **2026-07-10 (later)** — marketing + advisors bases pruned (14,713 homepages read):
  marketing 12,293 → **10,838** (1,450 same-firm extras + 5 parked deleted, 30 first names
  fixed); advisors 7,815 → **7,813** (2 parked deleted, 9 first names fixed; 3,611 same-firm
  contacts KEPT per the keep-all-contacts decision). Flags for eventual review in
  `consulti-review-2026-07-11.csv`: 188 unreachable, 158 placeholder sites.
