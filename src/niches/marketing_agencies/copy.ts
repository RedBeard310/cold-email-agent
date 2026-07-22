// marketing_agencies — email copy. Provided by Casey (pasted 2026-07-22); this repo does
// NOT write copy (SPEC.md §9). Edits applied here are limited to: merge-tag normalization
// ([first name] / {{first name}} -> {{first_name}}) and fixing encoding artifacts from the
// source doc (mojibake dash -> "—", curly quotes -> straight). Wording is otherwise verbatim.
//
// A/B test: Seq A (Justin Hillsberg style) vs Seq B (Matt Lucero style). Both share the
// subject "quick one" on purpose — subject is deliberately NOT a test variable.
//
// LINE BREAKS ARE LOAD-BEARING (Casey, 2026-07-22): one blank line between every
// sentence/paragraph, exactly as pasted — saveSequences turns \n into <br>, so this file's
// spacing is what recipients see. Don't collapse or reflow.
//
// Merge tag: {{first_name}} <- first_name (clean-cased in base), fallback "there".

import type { SequenceDef } from '../../engine/types';

export const SUBJECT = 'quick one';

const SIGNATURE = `— Casey
Content Gets Clients`;

const PS_AMANDA = `PS - I took my client Amanda's financial agency from 0 to 12k subscribers in a year, now doing just under $1M/year with 100% of clients from YouTube. (Search "Retirement Income School" on YouTube).`;

// ---------------- Seq A — Hillsberg ----------------

const HILLSBERG_E1 = `Hey {{first_name}},

I'll produce an entire YouTube video for your agency for free - idea, script, thumbnail, editing, etc.

Can I send over more info?

${SIGNATURE}

${PS_AMANDA}`;

const HILLSBERG_E2 = `Hey {{first_name}},

Most agency owners tell me the same thing: they know YouTube works, they just don't have time to figure it out.

That's the point of the offer. I handle the idea, script, thumbnail, and editing, you just hit record.

Mind if I send more info?

${SIGNATURE}`;

const HILLSBERG_E3 = `Last one from me.

The offer stands: One full YouTube video for your agency, free: idea, script, thumbnail, editing. If it books you sales calls, great. If not, you're out nothing.

Want it? Just reply "info" and I'll send everything over.

Either way, I'll stop here.

${SIGNATURE}`;

// ---------------- Seq B — Lucero ----------------

const LUCERO_E1 = `Hey {{first_name}},

You run an agency, which means you're buying clients through ads or cold outreach. Both work. Both get pricier every month.

A YouTube channel fixes that. It shows your trust and authority before the sales call, so your cost per acquisition drops and closing gets easier.

To prove it, I'll produce an entire YouTube video for your agency for free - idea, script, thumbnail, editing, etc.

Want it? Reply "video" and it's yours.

${SIGNATURE}`;

const LUCERO_E2 = `Hey {{first_name}},

Every prospect you talk from outreach or ads is cold.

Imagine if you had a thriving YouTube channel you could show them. YouTube does the trust-building before the call ever starts. Your cost per acquisition drops across every channel you're running.

The offer from my last email still stands: one full video for your agency, free. Idea, script, thumbnail, editing, all of it.

Reply "video" and it's yours.

${PS_AMANDA}

${SIGNATURE}`;

const LUCERO_E3 = `Last email from me.

Your ads will cost more next year than they do today. That's the only direction they go.

A YouTube channel moves the opposite way: Every video you post keeps booking calls without you paying for them again. It's the only acquisition channel that gets cheaper over time.

One full video for your agency, free, is still on the table. Idea, script, thumbnail, editing.

Reply "video" and I'll get started this week.

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
