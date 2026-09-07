// marketing_agencies — email copy v2. Provided by Casey (pasted 2026-07-22, replacing the
// day-1 copy); this repo does NOT write copy (SPEC.md §9). Edits applied here are limited to:
// merge-tag normalization ([first name] / {{first name}} -> {{first_name}}), fixing encoding
// artifacts from the source doc (mojibake apostrophes/quotes/dashes/ellipsis), one flagged
// typo fix ("not worries" -> "no worries", Justin E3), and the spintax pass. Wording is
// otherwise verbatim.
//
// Spintax level: ~6/10 per Casey (2026-07-22) — "slightly more than the first pass, not much":
// greeting + a few small verb/connective/CTA spins per email, mostly 2 variants each. Rules
// from the Lucero repo (spin greetings/verbs/CTAs, same idea) + Voice Firewall (read-aloud
// test; "— Casey" sign-off em dash is the one ratified exception). NOT varied: proof claims
// and numbers, the subject line, paragraph/line-break structure.
//
// Note: v2 copy has no reply-keyword CTAs ("video"/"info" are gone) — soft CTAs by design.
// The two sequences now carry DIFFERENT Amanda PS texts (Justin E1 vs Lucero E2) — per the
// source doc, kept as written. Sign-off normalized to the established single-line-break
// signature everywhere (the doc was inconsistent in the Lucero follow-ups).
//
// LINE BREAKS ARE LOAD-BEARING (Casey): one blank line between every sentence/paragraph,
// exactly as pasted — saveSequences turns \n into <br>. Don't collapse or reflow. Spintax
// varies wording inside a line only, never the layout.
//
// Merge tag: {{first_name}} <- first_name (clean-cased in base), fallback "there".

import type { SequenceDef } from '../../engine/types';

export const SUBJECT = 'quick one';

const GREET = '{Hey|Hi} {{first_name}},';

// The sign-off names whoever SmartLead actually sends from, and that is picked at send time
// across a rotating pool of mailboxes. Twelve of them have belonged to invented people since
// 2026-09-05, so a fixed "Casey" here would sign their mail with his name. SmartLead resolves
// %sender-firstname% against the mailbox it really used. See claude-skills/_shared/README-sender-identity.md.
const SIGNATURE = `— %sender-firstname%`;

// ---------------- Seq A — Hillsberg (Justin) ----------------

const JUSTIN_E1 = `${GREET}

I'll {produce|make} an entire YouTube video for your agency for free - idea, script, thumbnail, editing, etc.

{Can I send over more info?|Can I send you more info?}

${SIGNATURE}

PS - I took my client Amanda's financial agency from 0 to 12k subscribers in a year, now doing just under $1M/year with 100% of clients from YouTube. ({Search|Look up} "Retirement Income School" on YouTube).`;

const JUSTIN_E2 = `${GREET}

{You probably already know|You probably know} the power of YouTube but just don't have the time to figure it all out {for yourself|on your own}.

That's the exact problem I solve…

I {handle|take care of} the idea, script, thumbnail, and editing, you just hit record.

{Mind if I send more info?|Mind if I send over more info?}

${SIGNATURE}`;

const JUSTIN_E3 = `{Last one from me.|This is my last one.}

The offer {stands|still stands}: One full YouTube video for your agency, free: idea, script, thumbnail, editing.

If it books you sales calls, great. If not, no worries, it didn't cost you {anything|a thing}.

Let me know if you want {some more info|more info}, I'd be happy to chat.

${SIGNATURE}`;

// ---------------- Seq B — Lucero ----------------

const LUCERO_E1 = `${GREET}

{I'm sure|I'd bet} you're doing either ads or cold outreach to get clients (probably both).

A thriving YouTube channel will massively improve the results of both of these (by "improve results" I mean bring down your cost per client acquisition and make the entire sales process much easier.)

People see you showing off your expertise on YouTube and {this builds trust|that builds trust}.

To prove it, I'll {produce|make} an entire YouTube video for your agency for free - idea, script, thumbnail, editing, etc.

Let me know if {you feel|you think} it's worth a quick {conversation|chat}.

${SIGNATURE}`;

const LUCERO_E2 = `${GREET}

The offer for a free video {still stands|is still on the table}.

PS - I took my client Amanda's financial agency from 0 to 12k subscribers in a year and she's doing just under $1M/year. The YouTube channel builds massive trust because she shows off her expertise and the prospects can see her entire process. ({Search|Look up} "Retirement Income School" on YouTube to see her channel).

${SIGNATURE}`;

const LUCERO_E3 = `{Last email from me.|This is my last email.}

I'll prove the power that a YouTube channel has on making ads and cold outreach convert better with a free video.

Yes, the first video is {100% free|completely free}.

Send this video to all the fence-sitters {who you've|you've} spoken to in the past but never converted, and you'll see a few of them bite.

${SIGNATURE}`;

export const sequences: SequenceDef[] = [
  {
    name: 'Seq A — Hillsberg',
    emails: [
      { delayDays: 0, subject: SUBJECT, body: JUSTIN_E1 },
      { delayDays: 3, body: JUSTIN_E2 },
      { delayDays: 3, body: JUSTIN_E3 },
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
