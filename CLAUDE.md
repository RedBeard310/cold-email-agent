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
- **Do NOT run the gate from this machine — paused permanently (Casey, 2026-07-22).** The gate now runs from a dedicated repo on Casey's VPS; local runs would be redundant. The SessionStart hook that ran it here was removed on 2026-07-22, and the send path must NOT shell out to `npm run inbox-health`. Do not re-add any local gate automation unless Casey explicitly says to turn it back on.
- **Manual check (changes nothing):** `cd /Users/caseybrown/Claude/youtube-email-outreach-v1 && npm run inbox-health -- --status`.

## Campaign hard rules (2026-07-13 incident — do not regress)

On 2026-07-13 we discovered every ACTIVE campaign (all 3 FA + all 10 Dream 100) was silently sending from only **12 legacy inboxes at 25 new leads/day**, because `create`/`attach-inboxes` mirrored the old Dream 100 campaign's settings and inbox pool — the 120-inbox fleet sat unused. These rules are enforced by `npm run cea -- fleet:audit --fix` ([src/engine/fleet.ts](src/engine/fleet.ts)), which also runs staleness-gated (12h) from the SessionStart hook in `.claude/settings.local.json`:

1. **Every ACTIVE campaign gets the FULL account inbox pool attached** — never a subset, never a mirror of another campaign's pool. The inbox health gate (account-level `is_suspended`) decides which inboxes actually send; attaching suspended/warming inboxes is safe and means they auto-join every campaign the moment the gate releases them. (Note: SmartLead's `GET /email-accounts` list does NOT return `is_suspended` — don't conclude "nothing is paused" from it; the gate's `--status` output is ground truth.)
2. **`max_new_leads_per_day` is always 99,999** (effectively uncapped — SmartLead accepts it). Throughput is governed by per-inbox `message_per_day` limits and the health gate — the right layers — never by a campaign-level lead cap.
3. **New campaigns must pass `fleet:audit` before `start`.** `attach-inboxes` and `mirrorSettings` in [src/cli.ts](src/cli.ts) now comply (full pool + uncapped); don't reintroduce mirroring of caps or inbox subsets.
4. SmartLead campaign status `COMPLETED` means the campaign finished every lead's sequence (all leads `COMPLETED`/`BLOCKED`, nothing pending). Terminal but reversible — adding leads reactivates it.

## Secrets

All secrets come from the **shared `env-storage` repo**, not a local `.env` (consistent with sibling projects):

- Path: `/Users/caseybrown/Claude/env-storage/.env`
- Keys (confirmed present): `SMARTLEAD_API_KEY`, `AIRTABLE_PAT`

## Hard constraints / non-goals (SPEC.md §9)

- **Do NOT reuse or draw from the YouTube-creator cold-email repos or skills** (e.g. `youtube-email-outreach-v1`, the `cold-email-nick-saraev` skill). Those target creators who *already have* a channel; here we *sell YouTube* to people who don't. Opposite audience, opposite message. This is the easiest mistake to make given the YouTube-outreach tooling in this account — don't.
- **No lead discovery / enrichment here** — that's the upstream per-niche repos.
- **No copywriting here** — copy is provided externally per niche.

## Ecosystem conventions (house style — follow when adding code)

This project sits among sibling repos under `/Users/caseybrown/Claude/`. The closest relative, [finance-lead-finder](../finance-lead-finder/), establishes the house style this repo should follow when code is added: **TypeScript/Node ESM** (`"type": "module"`, Node ≥20), run via **`tsx`** with a thin `src/cli.ts` dispatching subcommands, `tsc --noEmit` for typecheck, `dotenv` + `zod`, and **pluggable adapters in their own `src/` subfolders** (mirroring how niche configs should plug into the engine here). No build/test commands exist in *this* repo yet — do not invent them; add them as you build, matching that convention.

## How to write replies to me

Keep your replies short and sweet. Don't cut any necessary information or important details, but aim for brevity when explaining them.

Lead with what changed and what it means for me — not what you did step by step.
Plain language, no unnecessary technical jargon. Explain a term only if I need it
to make a decision.

Keep it short and spaced out: brief paragraphs, bold labels, a table when
comparing two or more things. No walls of text, no filler openers.

Include, briefly, anything that changes my picture of the work:
- what you actually verified vs. assumed
- anything surprising you found along the way
- decisions I still need to make, as a short list at the end

Cut everything else.

---

## Voice Firewall (house law, wired 2026-07-23 — read before writing any prose)

Every reader-facing sentence this repo produces must pass the Voice Firewall. Before writing, read the canonical file:

- Mac: `~/Claude/casey-assistant/brain/content-strategy/voice-firewall.md`
- VPS: `/home/casey/repos/casey-assistant/brain/content-strategy/voice-firewall.md`

Default cleverness = **level 2 (Dry)** unless the task names a level. The 1-5 levels and their golden examples live in `casey-assistant/brain/content-strategy/cleverness-scale.md` (same folder). Where this repo and the Law differ, the Law wins (the old "stricter wins" tie-breaker was retired 2026-07-28). Its clarity core is Clear Writing, in the managed block below.

Fallback (ONLY if the canonical file is unreachable): zero em dashes; level-2 dry style (plain, direct, no ornament, no imagery); every line passes the read-aloud listener gate; and state in your output that the full firewall was not loaded.

<!-- LLM-SPEND-GUARD v1 — managed block; keep identical in every repo -->
## LLM Spend Guard (house law — applies in every repo)

**Subscription chat is fine.** Work billed to a subscription plan (Claude Code on the Max plan, Codex on a ChatGPT plan, whatever the tool) needs no disclosure — just do the task.

**LLM API credits require disclosure BEFORE starting.** If a task will spend metered LLM API credits from ANY provider (Anthropic, OpenAI, OpenRouter, Gemini, Groq, etc.) — including launching a script, pipeline, or service that makes LLM SDK/API calls — the output must state, before the task begins:

- that it will spend API credits, and which provider/key (key by NAME only, never the value)
- a rough dollar estimate

**Estimated ≥ $1 → hard stop.** Do not start the task until Casey explicitly approves the spend.

**Scope: LLM usage only.** Non-LLM paid APIs (Deepgram, Apify, SmartLead, YouTube, etc.) are exempt from this rule.

**Limitation:** this governs chat-initiated work. Headless automation that is already running doesn't re-read this file mid-run; the rule applies at the moment a session starts, modifies, restarts, or triggers that automation.
<!-- /LLM-SPEND-GUARD -->

<!-- SUBSCRIPTION-NOT-API v1 — managed block; keep identical in every repo -->
## Subscription, not API (house law — wired 2026-08-05)

**Headless `claude -p` in automation bills Casey's Max subscription. It must never bill the Anthropic API.**

Claude Code *prefers* `ANTHROPIC_API_KEY` over the subscription login whenever that variable is in its environment. So any script that loads the shared env and then spawns `claude` silently moves its spend off the already-paid plan onto metered credit. That leak ran **~$10–16/day** through 2026-08-03/04. The 2026-08-01 attempt to fix it failed because it patched only interactive shells (`~/.bashrc`) and three shell scripts, and missed seven copy-pasted `load_env()` functions — which is why the fix now lives *below* the scripts.

**Three layers. Do not remove any of them:**

1. **`ANTHROPIC_API_KEY` is stripped at the env-storage sync boundary** (`sync-to-vps.sh`, `MAC_ONLY`), so the key does not exist on the VPS at all. Automations that don't exist yet inherit the fix.
2. **`/usr/bin/claude` on the VPS is a shim** that unsets the key and execs the real binary. It sits at `/usr/bin/claude` rather than `/usr/local/bin` because some scripts hard-code that path. `claude-shim-guard.timer` re-asserts it every 15 min, because `npm update -g` restores the original symlink.
3. **This rule**, so no future script re-opens it.

**Choosing where a new LLM call goes:**

- **Judgment, tool use, writing → the Claude Code CLI.** It is free on the plan. Do not move work onto a paid API to "save money" — that costs more, not less.
- **High-volume mechanical work (classification, extraction, tagging) → OpenRouter.** Not for cost; for **rate limits**. A burst of CLI agents draws on the same Max limit as Casey's own interactive sessions. Route it with an `openrouter:` prefix in `models.json`.

**Ops footgun:** never `cp` a file over `/usr/bin/claude` without `rm`-ing it first. It may be a symlink, and `cp` writes straight through it and destroys the ~275MB real binary. Recovery is `sudo npm install -g @anthropic-ai/claude-code@<version>`.
<!-- /SUBSCRIPTION-NOT-API -->

## Model Policy (house law — wired 2026-08-01)

**Which LLM this repo uses for any task is set in `models.json` at the repo root — never in code, never in env.** Read the house standard before changing a model or adding an LLM call:

- Mac: `~/Claude/casey-assistant/brain/infrastructure/model-policy.md`
- VPS: `/home/casey/repos/casey-assistant/brain/infrastructure/model-policy.md`

House default for research / mining / synthesis work is `openrouter:deepseek/deepseek-v3.2`. Model ids are configuration and are committed; API keys stay in the shared env. Env-based model selection is banned — the Mac clobbers the VPS env file every ~2 minutes, which silently reverted a swap and burned ~$22 of unplanned Sonnet on 2026-07-31.

To change a model: edit `models.json` and commit. Do not hard-code a model id in any module.

<!-- CLEAR-WRITING v1 — managed block; keep identical in every repo -->
## Clear Writing (house law — wired 2026-08-06)

**Every piece of prose a person will read passes through Clear Writing.** Chat replies, emails, docs, reports, READMEs, notes, commit messages, slide text, Notion pages, client deliverables. No exceptions, in any repo.

**The one bar:** *if a smart high-schooler couldn't follow the idea on the first pass, rewrite it.* Assume the reader knows nothing about the business, hasn't read your other work, and won't read the sentence twice.

The rules, short version:

1. **Read it cold as the person who'll read it.** If a line needs the thinking behind it explained, it fails.
2. **Define at first use, then restate simpler.** The definition can't contain the confusion. Defining jargon with jargon fails.
3. **Bridge anything unfamiliar** to something they already know ("it's kinda like..."), then retire the bridge. One analogy per idea, taught in full sentences, connected back once, then back to literal words.
4. **Zero em dashes.** Commas for asides, periods for full thoughts. Carve-outs: the "— Casey" sign-off and structural separators in a locked template.
5. **No corporate filler** (unlock, leverage, elevate, move the needle), **no strategist vocabulary** in reader-facing text (funnel, ICP, pain point, install a belief), **no LLM dialect** ("here's the kicker"), **no hedging** (maybe, I think, sort of).
6. **No "not X, it's Y" as decoration.** Legal only when swapping an old belief the reader actually holds.
7. **Unpack compressed phrasing.** "A see-it-coming cost" becomes "a cost you can see coming." If a phrase squeezes an action into a metaphor or a hyphen stack, say the action.
8. **No bumper-sticker closers.** End on the actual mechanic in literal words, never an aphorism.
9. **Two links is the ceiling on a causal chain.** State the conclusion and trust the reader.
10. **Contractions on.** Talk TO the reader. Contraction-free essay prose is its own AI tell.
11. **Concrete beats abstract.** Specifics over adjectives, a worked example over an elegant abstraction, the believable number over the impressive one.
12. **Never present an invented specific as a real fact.** Ask for it instead.

**Cleverness runs at level 2 (Dry) by default**, everywhere. Plain and direct, no ornament. A format skill may name a different default for its own format (long-form scripts run at 3).

**Full standard** (read it before any substantial writing or rewrite job):

- Mac: `~/Claude/casey-assistant/brain/content-strategy/clear-writing.md`
- VPS: `/home/casey/repos/casey-assistant/brain/content-strategy/clear-writing.md`
- Skill: `clear-writing` (invoke it for rewrite jobs; it carries the linter at `scripts/lint.mjs`)

**Scope note.** Clear Writing is a clarity standard, not a persuasion standard. It carries none of the YouTube machinery: no proof stacking, no multiple analogies per idea, no Give Then Gap hook, no CTA rules, and no abrupt ending. **A normal conclusion is allowed.** That machinery stays in `long-form-writing-skill-v3`. For writing another person will read, the Voice Firewall still outranks this block, and format skills add structure on top. Neither may loosen the bar above.
<!-- /CLEAR-WRITING -->

<!-- NOTION-ACCESS v1 — managed block; keep identical in every repo -->
## Notion Access (house law — wired 2026-08-10)

**There is a Notion API token in the shared env: `NOTION_API_TOKEN`.** It works from any repo, on the Mac and on the VPS, in any session, including headless ones.

**Never report that you can't reach Notion because a connector isn't signed in.** The claude.ai Notion connector has to be authorized per session and doesn't exist in automation. It is a convenience, not the way in. If it isn't there, use the API and carry on with the task.

```bash
curl -s -X POST "https://api.notion.com/v1/databases/<DATABASE_ID>/query" \
  -H "Authorization: Bearer $NOTION_API_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"page_size":100}'
```

The four things that trip this up:

1. **Pin `Notion-Version: 2022-06-28`.** Notion changes response shapes between versions.
2. **Paginate.** One request returns 100 rows at most. If the reply says `"has_more": true`, send it again with `"start_cursor"` set to the `next_cursor` you got back. Skip this and a 115-row database silently looks like a 100-row one.
3. **Read the ID off the URL correctly.** In `app.notion.com/p/<workspace>/<32-char-id>?v=<other-id>`, the chunk in the path is the ID. The one after `?v=` is a saved view and the API rejects it.
4. **A 404 usually means "not shared," not "missing."** Notion integrations only see what someone hands them. Ask Casey to open the page, click `...`, go to Connections, and add "API For Claude?".

Key values must never be printed, echoed, logged, or committed. That applies to the token itself and to any secret stored inside a Notion database. Pull those into a file, redact before displaying, delete the file after.

**Full standard** (which databases are reachable, the endpoint table, working code to copy):

- Mac: `~/Claude/casey-assistant/brain/infrastructure/notion-access.md`
- VPS: `/home/casey/repos/casey-assistant/brain/infrastructure/notion-access.md`
<!-- /NOTION-ACCESS -->
