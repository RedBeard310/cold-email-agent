# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state: spec-only, pre-implementation

This repo currently contains **only `SPEC.md` and `README.md` — no code, no `package.json`, no build/test/lint, not yet a git repo.** Read [SPEC.md](SPEC.md) first; it is the governing document. The spec is deliberately broad — sequencing, copy mapping, and per-campaign mechanics are decided *while building*, not pre-specified (see SPEC.md §8 for what is intentionally left open). When you implement something the spec left open, you are making the decision, not discovering it.

## What this is

A **generalist, send-side cold-email outreach agent**. It reads an already-built lead list for a "niche" from Airtable, maps lead fields to SmartLead personalization variables, and pushes leads into SmartLead campaigns. **SmartLead** (not this agent) owns all sequencing, sending, inbox rotation, warmup, and reply detection.

It does **not** discover, enrich, or write copy. Those happen upstream/externally.

## The one load-bearing idea: generic engine + pluggable niche configs

The entire design rests on **niche-agnostic core, niche-specific config** (SPEC.md §3):

- **Core engine** knows nothing about any vertical: SmartLead client, Airtable lead loading, field→variable mapping, suppression/dedup, secret wiring.
- **Niche config** (one self-contained unit per target category) declares: its Airtable base/table, its field map, its SmartLead campaign(s), its offer/angle, and a pointer to where its copy lives.

**Adding a niche = add a niche config, never a new repo.** Keep all vertical-specific logic inside niche configs; if you find yourself special-casing a vertical in the engine, that's the wrong layer.

## First niche: `financial_advisors`

The only fully-defined niche (SPEC.md §4). Audience: independent state-registered RIAs who **do not** have a YouTube channel. The offer is "you should *start* using YouTube to get clients" — **not** "you already have YouTube." Lead source: Airtable base **`appvEVgfYvyNIms2h`** (~4,565 verified leads). Lead fields and suggested segmentation levers (by `tag`, e.g. `retirement_income`; by `email_origin`, `scraped` before `constructed`) are in SPEC.md §4.

## Integration points (the whole job lives at these two boundaries)

```
finance-lead-finder ──► Airtable (per-niche base) ──► THIS AGENT ──► SmartLead (campaigns/sending)
```

- **Upstream:** [finance-lead-finder](../finance-lead-finder/) produces the financial-advisor lead list into Airtable base `appvEVgfYvyNIms2h`. Each future niche gets its own upstream repo + own base.
- **Downstream:** the existing SmartLead account, inboxes, and warmup — no new account.

## Inbox health gate — shared SmartLead inboxes (lives in `youtube-email-outreach-v1`)

This agent sends through the **same SmartLead account, inboxes, and warmup** as the rest of the ecosystem (see Integration points above / SPEC §6). Those inboxes are protected by an **inbox health gate** that already exists in the sibling repo `youtube-email-outreach-v1`. Since 2026-06-16 the gate reads per-mailbox warmup health from **InboxKit** and pauses/resumes the matching SmartLead inbox via `is_suspended`. Pause rules: health_score < 90, OR warmup day < 14, OR landing rate < 90 once an inbox has real volume. It runs at most once per 24h (staleness-gated) and never blocks sending if it errors.

**Why this matters here even though this repo doesn't own the gate:** suspension happens at the **SmartLead account level**, so the protection is shared automatically. SmartLead will not send from a gate-paused inbox no matter which agent loaded the leads. So as long as the gate has run recently, this agent only ever sends from properly-warmed, healthy inboxes — which is exactly the requirement.

**This is the one sanctioned reference to `youtube-email-outreach-v1`.** SPEC §9 / "Hard constraints" forbids drawing on the YouTube-creator repos — that rule is about **copy, audience, and skills**, which stay off-limits. The inbox health gate is **shared SmartLead/InboxKit infrastructure**, not copy. Don't import its code; just let it do its job and keep its state fresh.

Rules for this repo:

- **Don't suspend/resume SmartLead inboxes from here.** That lever is owned by the gate (and its `.inbox-health-state.json` in `youtube-email-outreach-v1`). Flipping `is_suspended` from this agent would fight it — the gate re-pauses inboxes you resume and won't auto-resume ones it didn't pause.
- **Send capacity floats automatically.** The set of live inboxes changes as warmup health rises and falls. Expected, not a bug. Don't hardcode an inbox count or assume a fixed sending pool.
- **Keep the gate fresh around a send batch.** A local SessionStart hook (in this repo's gitignored `.claude/settings.local.json`) runs the gate when you open this repo, so health is refreshed at your usual entry point. When you build the send path, also refresh it right before pushing: shell out to `cd /Users/caseybrown/Claude/youtube-email-outreach-v1 && npm run inbox-health` (staleness-gated, so it's a cheap no-op when already fresh). Don't reimplement the gate.
- **Manual check (changes nothing):** `cd /Users/caseybrown/Claude/youtube-email-outreach-v1 && npm run inbox-health -- --status`.

**Recommendation (not done — flagging for Casey):** two send-side agents now depend on a gate that physically lives inside one of them. The clean long-term move is to extract the gate into a shared location (its own small repo, or an `env-storage`-adjacent util) so neither send agent "owns" it. Until then the coupling above is the pragmatic path — documented so it's deliberate, not accidental.

## Secrets

All secrets come from the **shared `env-storage` repo**, not a local `.env` (consistent with sibling projects):

- Path: `/Users/caseybrown/Claude/env-storage/.env`
- Keys (confirmed present): `SMARTLEAD_API_KEY`, `AIRTABLE_PAT`

## Hard constraints / non-goals (SPEC.md §9)

- **Do NOT reuse or draw from the YouTube-creator cold-email repos or skills** (e.g. `youtube-email-outreach-v1`, the `nick-saraev-cold-email` skill). Those target creators who *already have* a channel; here we *sell YouTube* to people who don't. Opposite audience, opposite message. This is the easiest mistake to make given the YouTube-outreach tooling in this account — don't.
- **No lead discovery / enrichment here** — that's the upstream per-niche repos.
- **No copywriting here** — copy is provided externally per niche.

## Ecosystem conventions (house style — follow when adding code)

This project sits among sibling repos under `/Users/caseybrown/Claude/`. The closest relative, [finance-lead-finder](../finance-lead-finder/), establishes the house style this repo should follow when code is added: **TypeScript/Node ESM** (`"type": "module"`, Node ≥20), run via **`tsx`** with a thin `src/cli.ts` dispatching subcommands, `tsc --noEmit` for typecheck, `dotenv` + `zod`, and **pluggable adapters in their own `src/` subfolders** (mirroring how niche configs should plug into the engine here). No build/test commands exist in *this* repo yet — do not invent them; add them as you build, matching that convention.
