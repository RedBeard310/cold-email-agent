// Off-machine ledger of every lead we've ever paid Consulti for.
//
// Why it exists (Casey, 2026-07-10): the cursor file and raw CSVs are local-only and
// gitignored, and Airtable only holds APPROVED leads — the bought-but-rejected slice lives
// nowhere else. This mirrors every billed email into a Consulti list on THEIR servers, so a
// dead laptop can't make us re-buy leads: export the list from the UI and the dedupe memory
// is restored. (The API can't read list members back or exclude lists from searches — this is
// a recovery ledger and a UI-exclusion candidate, not an active filter.)
//
// All calls are free; duplicates are ignored server-side.
import fs from 'node:fs';
import path from 'node:path';
import { getLists, createList, addLeadsToList } from './client';
import { parseCsv } from './pull';

export const LEDGER_NAME = 'Already Exported - All Niches';
const CHUNK = 500;

/** Find the ledger list by name (no local state — survives machine loss), creating it if absent. */
export async function ensureLedger(): Promise<{ id: string; memberCount: number }> {
  const lists = await getLists();
  const found = lists.find((l) => l.name === LEDGER_NAME);
  if (found) return { id: found.id, memberCount: found.member_count };
  const id = await createList(
    LEDGER_NAME,
    'Every lead ever exported via API or UI, all niches. Recovery ledger — do not delete.',
  );
  return { id, memberCount: 0 };
}

/** Push emails to the ledger in chunks. Returns how many were new vs already present. */
export async function pushToLedger(emails: string[]): Promise<{ added: number; skipped: number }> {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))];
  const { id } = await ensureLedger();
  let added = 0;
  let skipped = 0;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const r = await addLeadsToList(id, unique.slice(i, i + CHUNK));
    added += r.added;
    skipped += r.skipped;
  }
  return { added, skipped };
}

/** Backfill: every email in every CSV under .consulti/ (raw pulls + UI list exports). */
export async function backfillLedger(): Promise<void> {
  const dir = '.consulti';
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.csv'));
  const emails: string[] = [];
  for (const f of files) {
    const rows = parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
    const before = emails.length;
    for (const r of rows) if (r.email) emails.push(r.email);
    console.log(`  ${f}: ${emails.length - before} emails`);
  }
  console.log(`Pushing ${new Set(emails.map((e) => e.toLowerCase())).size} unique emails to "${LEDGER_NAME}"…`);
  const { added, skipped } = await pushToLedger(emails);
  const { memberCount } = await ensureLedger();
  console.log(`Ledger: +${added} new, ${skipped} already present — ${memberCount} total members.`);
}
