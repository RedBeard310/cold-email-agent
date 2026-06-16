# cold-email-agent — Spec Sheet

> Status: **broad/foundational spec.** Intentionally light on details. Sequencing, copy
> mapping, and per-campaign mechanics are worked out as the project is built. This document
> defines *what the project is and how it's shaped* — not the exact email flow.

---

## 1. What this is

A **generalist cold-email outreach agent**. It sends cold email sequences to leads through
**SmartLead** (the email sequencer / sending platform), across **many different target
categories** — called **niches**.

It is **not** tied to one vertical. **Financial advisors are simply the first niche.** Over time
the same agent will run outreach to other niches (relocation experts, legal professionals,
doctors, dentists, and more), **without spinning up a new repo for each one.** One agent, many
niches.

The agent is **send-side only**: it takes an already-built list of leads for a niche and runs
outreach. It does **not** discover or enrich leads — that happens upstream (see §2).

---

## 2. Where this sits in the bigger picture

```
  [ discovery + enrichment repos ]        [ THIS PROJECT ]              [ SmartLead ]
   one per niche, e.g.                      cold-email-agent             account + inboxes
   finance-lead-finder  ───►  Airtable  ───►  read niche's leads  ───►  sequence + send + warm
   (RIA advisors)            (per-niche base)   push to campaign(s)      rotate inboxes, replies
```

- **Upstream (separate projects):** each niche has its own discovery/enrichment pipeline that
  produces a verified lead list in **its own Airtable base**. For the financial-advisor niche
  that upstream project is **`finance-lead-finder`**.
- **This project (`cold-email-agent`):** reads a niche's leads from Airtable, maps fields to
  SmartLead personalization variables, and pushes them into the right SmartLead campaign(s).
- **SmartLead:** owns the actual sequencing, sending, inbox rotation, warmup, and reply
  detection.

---

## 3. Core model: a shared engine + pluggable niche configs

The whole design rests on one idea: **niche-agnostic core, niche-specific config.**

### Core engine (knows nothing about any vertical)
- SmartLead API client (auth, campaigns, leads, status).
- Env/secret wiring (pulls keys from the shared **`env-storage`** repo).
- Lead loading from a source (Airtable).
- Field → SmartLead personalization-variable mapping.
- Suppression / dedup / do-not-contact handling.
- (Optional, later) status sync back to the source.

### Niche config (one per target category)
Each niche is a small, self-contained config that declares:
- **Lead source** — its own Airtable base/table.
- **Field mapping** — which lead fields fill which SmartLead variables.
- **SmartLead campaign(s)** — where this niche's leads go.
- **Offer / angle** — the pitch for this audience.
- **Copy pointer** — where this niche's email copy lives (copy itself is provided externally).

**Adding a new niche = add a niche config. Never a new repo.**

---

## 4. Defined niche #1 — `financial_advisors`

The first and currently only fully-defined niche.

- **Audience:** independent financial advisors (state-registered RIAs). **None of them have a
  YouTube channel** — that's the point.
- **Offer / angle:** sell them on **starting / using YouTube** to attract clients (Content Gets
  Clients' core offer). The angle is "you should be on YouTube," *not* "you already have YouTube."
- **Lead source:** Airtable base **`appvEVgfYvyNIms2h`** — **4,565 verified leads** produced by
  `finance-lead-finder`.
- **Fields available on each lead** (for personalization / segmentation):
  `legal_name`, `primary_name`, `owner_first_name`, `owner_last_name`, `email`,
  `email_origin` (`scraped` vs `constructed`), `verification_status`, `tags`
  (specializations, e.g. `retirement_income`), `aum`, `employees`, `iar_count`,
  `city`, `state`, `website`, `domain`.
- **Segmentation levers (suggestions, not rules):**
  - By **tag** — e.g. start with the **`retirement_income`** segment (~1,577 leads) as a beachhead.
  - By **`email_origin`** — the **`scraped`** addresses (~1,203) were published on the firm's own
    site, so they're the warmest; a natural **first wave**, with `constructed` as the larger
    follow-on.
- **Copy:** already written — provided to the project separately. Not defined here.

---

## 5. Future niches (acknowledged, not yet defined)

Placeholders only. Each will get its own upstream lead database (Airtable base) and its own niche
config when its turn comes:

- Relocation experts
- Legal professionals
- Doctors / dentists
- …others as identified

The architecture in §3 must make adding these trivial: new Airtable base + new niche config, same
engine, same SmartLead account.

---

## 6. Sending infrastructure — SmartLead

- **Sequencer:** **SmartLead** runs all sequencing, sending, inbox rotation, warmup, and reply
  detection. This agent does not send mail itself; it feeds SmartLead.
- **Account & inboxes:** uses the **existing SmartLead account and the same inboxes / sending
  domains / warmup** already in use. No new account.
- **API key:** **`SMARTLEAD_API_KEY`**, stored in the shared
  **`env-storage`** repo (`/Users/caseybrown/Claude/env-storage/.env`).
- **Agent's job at the SmartLead boundary:** push the right niche's leads into the right
  campaign(s) with correctly mapped personalization fields. (Exactly how campaigns/sequences are
  created and structured is **deliberately left open — see §8.**)

---

## 7. Lead source — Airtable

- Leads are read from **Airtable** (one base per niche).
- A niche config names its **base + table** and the **field map** to SmartLead variables.
- For `financial_advisors`: base `appvEVgfYvyNIms2h` (created/owned upstream by
  `finance-lead-finder`). **Airtable PAT** also comes from the shared `env-storage` repo.

---

## 8. Deliberately broad — to be worked out in the project

These are intentionally **not** specified here. Decide them while building:

- Exact email **sequence** (number of steps, timing, follow-ups).
- How **copy** is stored and wired into SmartLead per niche.
- Whether the agent **creates** SmartLead campaigns or pushes into **pre-made** ones.
- **Scheduling / throttling / daily send caps.**
- **Reply handling**, positive-reply routing, and **status write-back** to Airtable.
- **Suppression / dedup** across niches and prior sends.

---

## 9. Constraints & non-goals

- **Do NOT reuse the YouTube-creator cold-email repos or skills.** Those target people who
  *already have* a YouTube channel; here we *sell YouTube* to people who *don't*. Different
  audience, different message — no inspiration drawn from them.
- **No discovery / enrichment here.** Lead generation lives in the upstream per-niche repos.
- **No copywriting here.** Copy is provided externally per niche.
- **Keep all vertical-specific logic inside niche configs** — the engine stays generic so new
  niches drop in cleanly.

---

## 10. Secrets

All secrets are pulled from the shared **`env-storage`** repo
(`/Users/caseybrown/Claude/env-storage/.env`), consistent with the other projects:

- `SMARTLEAD_API_KEY` — SmartLead account.
- Airtable PAT — to read per-niche lead bases.
