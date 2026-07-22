// marketing_agencies — email copy. Provided by Casey (pasted 2026-07-22); this repo does
// NOT write copy (SPEC.md §9). Edits applied here are limited to: merge-tag normalization
// ([first name] / {{first name}} -> {{first_name}}), fixing encoding artifacts from the
// source doc, and the spintax pass below. Wording is otherwise verbatim.
//
// Spintax pass (Casey, 2026-07-22, densified same day on his feedback — spin nearly every
// sentence, phrase-level chunks welcome): per the Matt Lucero repo (transcripts 002/010/024:
// spin greetings, verbs, offer wording, CTAs — "slight differences, same idea") and
// lead-gen-jay (030: phrase-level chunks, go dense, against ESP fingerprinting). Every
// variant passed the Voice Firewall (casey-assistant/brain/content-strategy/voice-firewall.md):
// read-aloud test, no hedging, no banned vocabulary. The "— Casey" sign-off em dash is the
// firewall's one ratified exception (2026-07-22). NOT varied, ever: the Amanda proof NUMBERS
// (0->12k, $1M/yr, 100% — the PS's connective wording may spin, the numbers never), the reply
// keywords ("video"/"info"), the subject line, paragraph/line-break structure.
// Lucero E2's first line stays unspun pending Casey's call on the "you talk from" wording.
//
// A/B test: Seq A (Justin Hillsberg style) vs Seq B (Matt Lucero style). Both share the
// subject "quick one" on purpose — subject is deliberately NOT a test variable.
//
// LINE BREAKS ARE LOAD-BEARING (Casey, 2026-07-22): one blank line between every
// sentence/paragraph, exactly as pasted — saveSequences turns \n into <br>, so this file's
// spacing is what recipients see. Don't collapse or reflow. Spintax varies wording inside a
// line only, never the layout.
//
// Merge tag: {{first_name}} <- first_name (clean-cased in base), fallback "there".

import type { SequenceDef } from '../../engine/types';

export const SUBJECT = 'quick one';

const GREET = '{Hey|Hi|Hello} {{first_name}},';

const SIGNATURE = `— Casey
Content Gets Clients`;

const PS_AMANDA = `PS - {I took my client Amanda's financial agency|I grew my client Amanda's financial agency} from 0 to 12k subscribers in a year, {now doing|and she's now doing} just under $1M/year with 100% of clients from YouTube. ({Search|Look up} "Retirement Income School" on YouTube).`;

// ---------------- Seq A — Hillsberg ----------------

const HILLSBERG_E1 = `${GREET}

I'll {produce|make|create} {an entire|a full|a complete} YouTube video for your agency {for free|at no cost} - idea, script, thumbnail, editing, {etc.|the works.}

{Can I send over more info?|Can I send you more info?|Can I send more info?|Want me to send over more info?}

${SIGNATURE}

${PS_AMANDA}`;

const HILLSBERG_E2 = `${GREET}

Most agency owners {tell me|say} the same thing: they {know|already know} YouTube works, they just {don't have time|don't have the time|can't find the time} to figure it out.

That's the {point|whole point} of the offer. I {handle|take care of|do} the idea, script, thumbnail, and editing, {you just hit record|all you do is hit record}.

{Mind if I send more info?|Mind if I send over more info?|Can I send over the details?}

${SIGNATURE}`;

const HILLSBERG_E3 = `{Last one from me.|This is my last one.|Last email from me.}

The offer {stands|still stands}: {One full YouTube video|An entire YouTube video} for your agency, free: idea, script, thumbnail, editing. If it books you {sales calls|calls}, great. If not, {you're out nothing|you've lost nothing|it cost you nothing}.

{Want it?|Interested?} {Just reply|Reply} "info" and I'll send {everything|it all|the details} over.

Either way, {I'll stop here|this is where I stop|I won't email you again}.

${SIGNATURE}`;

// ---------------- Seq B — Lucero ----------------

const LUCERO_E1 = `${GREET}

You run an agency, {which means|so} you're {buying|paying for} clients {through|with} ads or cold outreach. Both work. {Both get pricier every month.|Both get more expensive every month.|Both cost more every month.}

{A YouTube channel fixes that.|A YouTube channel solves that.|A YouTube channel fixes that problem.} It {shows|proves} your trust and authority before the sales call, so {your cost per acquisition drops and closing gets easier|your cost per acquisition of a new client goes down and closing on sales calls is a lot easier|your cost to land a new client drops and closing gets a lot easier}.

{To prove it,|To show you,} I'll {produce|make|create} an entire YouTube video for your agency for free - idea, script, thumbnail, editing, etc.

{Want it?|Interested?} Reply "video" and it's {yours|all yours}.

${SIGNATURE}`;

const LUCERO_E2 = `${GREET}

Every prospect you talk from outreach or ads is cold.

{Imagine if you had|Picture having} a thriving YouTube channel you {could|can} show them. YouTube does the trust-building {before the call ever starts|before you ever get on the call}. {Your cost per acquisition drops|Your cost to land a client drops} across {every channel you're running|every channel you run}.

{The offer from my last email|My offer from the last email} still stands: {one full video|one entire video} for your agency, free. Idea, script, thumbnail, editing, {all of it|the whole thing}.

Reply "video" and it's {yours|all yours}.

${PS_AMANDA}

${SIGNATURE}`;

const LUCERO_E3 = `{Last email from me.|This is my last email.}

Your ads will {cost more|be more expensive} next year than they do {today|right now}. That's the only direction {they go|ad costs go}.

A YouTube channel moves {the opposite way|in the opposite direction}: Every video you post keeps booking {calls|you calls} without you paying for {them|those calls} again. It's the only acquisition channel that {gets cheaper over time|gets cheaper the longer you run it}.

{One full video|An entire video} for your agency, free, {is still on the table|still stands}. Idea, script, thumbnail, editing.

Reply "video" and I'll {get started|start} this week.

${SIGNATURE}`;

export const sequences: SequenceDef[] = [
  {
    name: 'Seq A — Hillsberg',
    emails: [
      { delayDays: 0, subject: SUBJECT, body: HILLSBERG_E1 },
      { delayDays: 3, body: HILLSBERG_E2 },
      { delayDays: 3, body: HILLSBERG_E3 },
    ],
  },
  {
    name: 'Seq B — Lucero',
    emails: [
      { delayDays: 0, subject: SUBJECT, body: LUCERO_E1 },
      { delayDays: 3, body: LUCERO_E2 },
      { delayDays: 3, body: LUCERO_E3 },
    ],
  },
];
