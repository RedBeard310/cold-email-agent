// financial_advisors — email copy. Provided by Casey; this repo does NOT write copy
// (SPEC.md §9). Edits applied here are limited to: confirmed typo/grammar fixes,
// single->double brace merge tags, and light spintax on greetings / CTAs only (never the
// claims). Approved claims (subscriber count, ~$1M revenue, 5-10 calls/week) are verbatim.
//
// Spintax: {a|b} varies per recipient at send time (SmartLead native).
// Merge tag: {{first_name}} <- owner_first_name, title-cased, fallback "there".
//
// Shared blocks (kept byte-identical where shared so the A/B stays clean):
//   Seq 1 E1 == Seq 2 E1   (shared opener A)
//   Seq 2 E2 == Seq 3 E2   (shared proof follow-up, both "their money")
//   Seq 2 E3 == Seq 3 E3   (shared closer)

import type { SequenceDef } from '../../engine/types';

export const SUBJECT = 'saw your practice';

const GREET = '{Hey|Hi} {{first_name}},';

// --- Opener A (shared by Seq 1 and Seq 2; byte-identical) ---
const OPENER_A_E1 = `${GREET}

Have you ever thought about getting more clients from YouTube?

My client Amanda Berrientez runs "Retirement Income School". She went from 0 to 12k subscribers in 1 year and is doing just shy of $1M per year in revenue. 100% of her clients come from YouTube.

We can help you attract 15 qualified prospects monthly by managing your entire YouTube presence.

We handle the scripting, research, editing, and posting. You just film the videos.

{Would you like to see|Open to seeing} how this could work for your business?`;

// --- Proof follow-up, Email 2 — shared by Seq 2 and Seq 3 (both "their money") ---
const PROOF_E2 = `${GREET}

Following up…, and I get it, your inbox is full of people promising leads.

The difference is I have the proof.

Amanda started from zero a year ago.

Now she books 5-10 calls per week on YouTube (and closes just shy of $1M per year).

Her prospects show up already warmed up: they've watched her explain how she'd handle their money *before* they book, so the calls are shorter and close higher.

You film a couple hours a month, I handle the rest.

{Open to a quick look?|Worth a quick look?}`;

// --- Closer (shared by Seq 2 and Seq 3; byte-identical) ---
const FOLLOWUP_LAST = `${GREET}

Last one from me… I'm not going to be the guy who emails ten times.

If "another YouTube pitch" isn't worth your time, no hard feelings.

But if getting prospects who show up pre-sold (the way Amanda's do) is something you want this year, I'll walk you through exactly how the system works on a quick call.

{Worth a quick chat?|Open to a quick chat?}`;

export const sequences: SequenceDef[] = [
  {
    name: 'Seq 1 — Reframe',
    emails: [
      { delayDays: 0, subject: SUBJECT, body: OPENER_A_E1 },
      {
        delayDays: 3,
        body: `${GREET}

{Floating this back up.|Bumping this back to the top.}

Here's why financial advisors and retirement income planners are crushing it on YouTube vs ads and outreach: The prospects come to you already warmed up. They've watched you explain how you'd handle their money *before* they ever book. So the calls are shorter and the close rate is higher.

All you need to do is film a couple hours a month. We do the scripting, research, editing, and posting.

{Worth a look at|Want to see} how it'd work for you?`,
      },
      {
        delayDays: 3,
        body: `I'll keep this one short.

You probably know that all the biggest players in the financial advisor/retirement income planning space are getting their leads from content.

Nothing beats the authority and ease of closing deals that creating raving fans on YouTube can provide.

Should I close the loop on this, or is it worth a quick call to see if it fits your practice?

Either way's fine, just don't want to keep landing in your inbox if it's not.`,
      },
    ],
  },
  {
    name: 'Seq 2 — Proof',
    emails: [
      { delayDays: 0, subject: SUBJECT, body: OPENER_A_E1 },
      { delayDays: 3, body: PROOF_E2 },
      { delayDays: 3, body: FOLLOWUP_LAST },
    ],
  },
  {
    name: 'Seq 3 — Pattern Interrupt',
    emails: [
      {
        delayDays: 0,
        subject: SUBJECT,
        body: `${GREET}

You probably get pitched "do YouTube for your practice" a couple times a month, so I'll skip the speech.

I work with Amanda Berrientez, who runs the YouTube Channel "Retirement Income School".

She went from 0 to 12k subscribers in a year, and she's now doing just shy of $1M/year from clients who found her on YouTube.

I handle everything: research, scripts, editing, posting. You just film.

Most people pitching this can't point to a client who actually books calls from it. I can.

Worth 15 minutes to see if it'd fit your practice?`,
      },
      { delayDays: 3, body: PROOF_E2 },
      { delayDays: 3, body: FOLLOWUP_LAST },
    ],
  },
];
