# Reminders — cold-email-agent

Shared notes for Casey + Claude. Add new reminders as numbered entries. If two ever conflict, the newer one wins.

## 1. Cold-email advice comes from the Matt Lucero knowledge repo

**Rule (strict):** Any time we need cold-email advice — copy structure, subject lines, sequencing/cadence, deliverability, segmentation, list-building, A/B testing, send volume, anything — pull from:

```
/Users/caseybrown/Claude/Writing Agents/Matt Lucero Writer and Knowledge
```

This is the cold-email brain. Matt Lucero runs **Anevo**, a B2B cold-email / appointment-setting agency — **10M+ cold emails sent, ~1M/month, 6,000+ SmartLead accounts, SmartLead certified partner.** The repo is a deep, *citeable* knowledge base:

- `Matt-Data/researched/examples-bank.md` — **76 frameworks, 104 examples, 34 case studies, 35 analogies, 80 credentials**, each cited to a source transcript.
- `Matt-Data/researched/transcripts/` — **48 full transcripts** (e.g. "7 Rules of Cold Email," the 600K-email platform study, segmentation, deliverability, full lead-gen courses).
- `Matt-Data/researched/` — ICP/avatar, channel, content-mix, outliers, audience questions.
- `Matt-Data/competitors/` — **31** cold-email / deliverability / lead-gen sources (SmartLead, Instantly, AJ Cassata, Eric Nowoslawski, Alex Berman, InboxAlly, EasyDMARC, Woodpecker, Belkins, SalesHandy, GMass, Warmy, ListKit, …).
- `WritingPrompt.md` — voice + structure rules.

**How to use it:** consult this repo **first** (before generic/default knowledge) when advising on cold email, and cite the specific framework/transcript when leaning on one.

**Why this is allowed (no conflict with the spec's YouTube ban):** SPEC §9 forbids reusing the *YouTube-creator outreach* repos/skills (`youtube-email-outreach-v1`, the `nick-saraev-cold-email` skill) — that ban is about their **copy + audience** (selling YouTube scripting to creators who already have channels). The Matt Lucero repo is cold-email **craft / methodology** (deliverability, sequencing, copy structure) — vertical-agnostic and exactly what we want. Read-only knowledge source; don't import its code.

## 2. Campaign naming + isolation from the Dream 100

**Rule (strict):** Financial-advisor campaigns are **separate SmartLead campaigns** from the existing "Dream 100" (YouTube-creator) campaigns — never load advisor leads into a Dream 100 campaign, and never touch those campaigns.

**Naming:** every campaign for this niche is prefixed `Financial Advisor: ` followed by the sequence name — e.g. `Financial Advisor: [Sequence 1 name]`. One campaign per sequence (the 3 sequences = 3 campaigns), which is also what makes the reply-rate A/B test clean.

When future niches come online they'll follow the same pattern with their own prefix (`Relocation: …`, `Legal: …`, etc.).

## 3. Marketing agencies niche — next steps (pick up here)

**Where it stands (2026-07-01):** The `marketing_agencies` niche's leads are DONE and loaded. 11,580 Apollo leads (from the "Marketing Agencies 1" saved search — small agencies, 1–20 employees, US/CA/AU/UK, owner/founder/CEO/managing-partner, verified emails) live in Airtable base **`appGzk9z2io4dPJUB`** ("Marketing Agency Leads", table "Leads"). Built via the new `src/apollo/` tooling; ~11,580 credits spent. See memory `marketing-agencies-leads` for full detail.

**Next steps (not started — resume next session):**

1. **Validate the emails.** ~11,566 have emails (11,563 already Apollo-verified), but run them through a verifier before sending. `EMAIL_VERIFIER_API_KEY` is in env-storage; the finance pipeline's `verification_status` field is the pattern to mirror.
2. **Write the email sequences / copy.** The offer is "sell agencies on [X]." Pull all copy/sequencing/cadence guidance from the Matt Lucero knowledge repo per reminder #1. Copy is provided/written per niche — not from the YouTube-creator repos (SPEC §9).
3. **Build a `marketing_agencies` niche config** (mirror `src/niches/financial_advisors/config.ts`): point it at base `appGzk9z2io4dPJUB`, map Airtable fields → SmartLead variables, set the campaign prefix (e.g. `Marketing Agency: `), then split + push into SmartLead — the SAME shared, inbox-health-gated SmartLead account as the advisors.

Not touching send infra until copy + validation are ready.
