# Sending Domains — "Content Gets Clients" cold-email fleet

Tracks the burner sending domains for cold outreach: which are live in InboxKit, which are
held back, their provider, and when each was added. Domains registered at **Spaceship**;
inboxes + warmup in **InboxKit** (workspace "Content Gets Clients"); sending (later) via **SmartLead**.

**Fleet setup:** 40 domains registered at Spaceship on **2026-06-27**. **3 inboxes per domain**,
local-parts `casey_brown`, `caseybrown`, `casey.brown` (sender identity "Casey Brown").

**InboxKit plan reality (discovered 2026-06-27):** plan = **Enterprise $299/mo = 100 Google slots,
0 Outlook slots**. Google mailboxes are free within the 100. Because of that, batch 1 is provisioned
**all-Google** (the originally-planned 50/50 Google/Outlook split was abandoned at batch-1 time).
18 legacy Outlook mailboxes from a prior plan remain active and untouched.

**Microsoft pricing reality (2026-07-10, per Wallet Logs):** the billing API's
`cost_per_add_on_ms_outlook_mailbox: 5` does not describe how checkout actually bills. Casey bought
the 51 batch-2 Microsoft mailboxes through the InboxKit UI; the wallet was debited two monthly
line items: **$140.25 "buying 51 mailboxes (monthly)" = $2.75/mailbox/mo**, plus
**$130.05 "Email Warmup addon" = $2.55/mailbox/mo** (quoted $3.00, 15% coupon applied at checkout).
Batch-2 all-in: **$270.30/mo ≈ $5.30/mailbox/mo**, paid from InboxKit wallet credits, prepaid one
month ahead (`renewal_cycle: monthly`). No add-ons appear on `/billing/subscription` — the wallet
logs / UI checkout are pricing ground truth, not the subscription metadata.

**Slot usage:** 81 / 100 Google used (12 legacy + 69 batch 1), 19 Google slots free.
Microsoft mailboxes: 69 (18 legacy + 51 batch 2), billed per-mailbox outside the Google slot pool.

---

## Batch 1 — LIVE — 23 domains / 69 Gmail inboxes — provisioned **2026-06-27**

- **Nameservers:** delegated to Cloudflare (InboxKit) 2026-06-27 — all 23 set + verified via `npm run cea -- infra:nameservers --file .infra/nameservers-batch1.csv --apply`. DNS records (MX/SPF/DKIM/DMARC) are managed by InboxKit in Cloudflare; Spaceship DNS is not authoritative, so `infra:dns` is not used here.
- **Mailboxes:** 69 created via `npm run cea -- infra:inboxes --file inboxkit-batch1.csv --apply` — all **Google**, status scheduled→active, then 14-day warmup. 3 per domain (`casey_brown@`, `caseybrown@`, `casey.brown@`).

| # | Domain | TLD | Provider | Inboxes | Added |
|---|--------|-----|----------|---------|-------|
| 1 | trycontentgetsclients.com | .com | Google | 3 | 2026-06-27 |
| 2 | getcontentgetsclients.com | .com | Google | 3 | 2026-06-27 |
| 3 | gocontentgetsclients.com | .com | Google | 3 | 2026-06-27 |
| 4 | withcontentgetsclients.com | .com | Google | 3 | 2026-06-27 |
| 5 | workwithcontentgetsclients.com | .com | Google | 3 | 2026-06-27 |
| 6 | teamcontentgetsclients.com | .com | Google | 3 | 2026-06-27 |
| 7 | joincontentgetsclients.com | .com | Google | 3 | 2026-06-27 |
| 8 | mycontentgetsclients.com | .com | Google | 3 | 2026-06-27 |
| 9 | askcontentgetsclients.com | .com | Google | 3 | 2026-06-27 |
| 10 | runcontentgetsclients.com | .com | Google | 3 | 2026-06-27 |
| 11 | contentgetsclientshq.com | .com | Google | 3 | 2026-06-27 |
| 12 | contentgetsclientsgroup.com | .com | Google | 3 | 2026-06-27 |
| 13 | contentgetsclientsmedia.com | .com | Google | 3 | 2026-06-27 |
| 14 | contentgetsclientsagency.com | .com | Google | 3 | 2026-06-27 |
| 15 | contentgetsclientsco.com | .com | Google | 3 | 2026-06-27 |
| 16 | contentgetsclientsteam.com | .com | Google | 3 | 2026-06-27 |
| 17 | contentgetsclientslabs.com | .com | Google | 3 | 2026-06-27 |
| 18 | contentgetsclientssend.com | .com | Google | 3 | 2026-06-27 |
| 19 | contentgetsclientsoutreach.com | .com | Google | 3 | 2026-06-27 |
| 20 | contentgetsclientsmail.com | .com | Google | 3 | 2026-06-27 |
| 21 | hirecontentgetsclients.net | .net | Google | 3 | 2026-06-27 |
| 22 | usecontentgetsclients.net | .net | Google | 3 | 2026-06-27 |
| 23 | trycontentgetsclients.net | .net | Google | 3 | 2026-06-27 |

---

## Batch 2 — LIVE — 17 domains / 51 Microsoft inboxes — connected + provisioned **2026-07-10**

- **Connected to InboxKit 2026-07-10** via `npm run cea -- infra:connect --file .infra/domains-batch2.txt --apply`
  (new command: connects each domain in InboxKit, which assigns its Cloudflare NS pair, then delegates
  the domain to those nameservers at Spaceship in one pass). All 17 got the NS pair
  `kai.ns.cloudflare.com` / `pearl.ns.cloudflare.com`; Spaceship read-back verified all 17.
  After the run, Spaceship-vs-InboxKit diff = 0 missing (50/50 domains match).
- **Mailboxes created 2026-07-10** — 51 **Microsoft** mailboxes, bought by Casey directly in the
  InboxKit UI ($2.75/mailbox/mo + $2.55/mo warmup addon; see pricing reality above), created ~16:48 UTC. Same 3-per-domain naming
  pattern (`casey_brown@`, `caseybrown@`, `casey.brown@`, sender "Casey Brown"). Verified via API:
  51/51 present, status scheduled → active, then warmup. `infra:inboxes --file inboxkit-batch2.csv`
  dry-run confirms "already exist 51 · to create 0" (idempotent; CSV kept as the batch-2 record).
- Batch 2 is deliberately **all-Microsoft** for provider diversity — batch 1 is all-Google.

| # | Domain | TLD | Provider | Inboxes | Connected | Mailboxes |
|---|--------|-----|----------|---------|-----------|-----------|
| 1 | contentgetsclients.org | .org | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 2 | getcontentgetsclients.net | .net | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 3 | gocontentgetsclients.net | .net | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 4 | contentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 5 | hirecontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 6 | usecontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 7 | trycontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 8 | getcontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 9 | gocontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 10 | withcontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 11 | workwithcontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 12 | thecontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 13 | teamcontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 14 | joincontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 15 | mycontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 16 | askcontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |
| 17 | runcontentgetsclients.co | .co | Microsoft | 3 | 2026-07-10 | 2026-07-10 |

---

## Status legend / next steps

- **Live** = in InboxKit, mailboxes provisioned, warmup running.
- **Connected** = in InboxKit with NS delegated to Cloudflare, no mailboxes yet.
- Full fleet is now provisioned: 40 domains / 120 fleet inboxes (69 Gmail batch 1 + 51 Outlook batch 2).
- After ~14-day warmup, connect batch-1 inboxes to SmartLead (warmup done ~2026-07-11); batch-2
  warmup completes ~2026-07-24. The existing inbox-health gate covers all of them automatically
  (account-level) once they're in SmartLead.
