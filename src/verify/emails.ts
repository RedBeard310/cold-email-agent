// Verify every email in a niche lead table with ZeroBounce and record the real result.
//
// Why this exists: the marketing-agencies leads carry Apollo's own `email_status` (almost all
// "verified"), which we never checked ourselves. This command re-checks each address with
// ZeroBounce and overwrites email_status with the true status, stamping the date we checked.
//
// Safe + resumable: the write is gated behind --apply; any record already carrying an
// email_verified_date is skipped, so an interrupted run (or hitting the credit ceiling) resumes
// cleanly on the next --apply. Distinct emails are verified once and the result fanned out to every
// row that shares the address (handles the handful of duplicate-email rows for free).
//
// email_status is a plain text column. This tool writes ZeroBounce's seven statuses (valid, invalid,
// catch-all, unknown, spamtrap, abuse, do_not_mail) plus our two housekeeping ones (not_checked,
// no_email). The table must already have email_verified_date and email_sub_status. Migration 0002
// added them where they were missing, and nothing here changes the schema.
import { fetchLeads, requireColumns, tableColumns, updateLeads, type LeadTable } from '../engine/db';
import * as zb from './zerobounce';

export const VERIFIED_DATE = 'email_verified_date';
export const SUB_STATUS = 'email_sub_status';
/** Columns both verify commands need (this one and consulti:verify). */
export const VERIFY_COLUMNS = ['email', 'email_status', SUB_STATUS, VERIFIED_DATE];

const normEmail = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** Run `fns` with at most `n` in flight at once. Preserves input order in the result array. */
export async function mapPool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export interface VerifyOpts {
  table: LeadTable;
  apply: boolean;
  reset: boolean;
  limit: number | null;
  concurrency: number;
}

export async function verifyEmails(opts: VerifyOpts): Promise<void> {
  const { table } = opts;
  console.log(`\n=== VERIFY EMAILS (ZeroBounce) — ${opts.apply ? 'APPLY (writes to the database + spends credits)' : 'DRY RUN (no ZeroBounce calls, no writes)'} ===`);
  console.log(`${table}${opts.limit != null ? ` · limit ${opts.limit} distinct emails` : ''} · concurrency ${opts.concurrency}\n`);

  const credits = await zb.getCredits();
  console.log(`ZeroBounce credits available: ${credits}`);

  await requireColumns(table, VERIFY_COLUMNS);

  console.log('\nReading records from the database…');
  const records = await fetchLeads(table, { columns: ['email', 'email_status', VERIFIED_DATE] });
  console.log(`  ${records.length} records`);

  // Records with no email at all: mark no_email (they can never be verified) — but never re-touch
  // a record we've already stamped.
  const blankNoDate = records.filter((r) => !normEmail(r.fields.email) && !r.fields[VERIFIED_DATE]);

  // Distinct un-verified emails -> the record ids that carry them.
  const byEmail = new Map<string, string[]>();
  for (const r of records) {
    const e = normEmail(r.fields.email);
    if (!e) continue;
    if (r.fields[VERIFIED_DATE]) continue; // already checked in a prior run — resume past it
    (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(r.id);
  }
  const alreadyDone = records.filter((r) => normEmail(r.fields.email) && r.fields[VERIFIED_DATE]).length;

  let emails = [...byEmail.keys()];
  console.log(`\n  ${alreadyDone} record(s) already verified (have ${VERIFIED_DATE}) — skipping`);
  console.log(`  ${emails.length} distinct email(s) to verify${blankNoDate.length ? `; ${blankNoDate.length} blank-email row(s) -> ${'no_email'}` : ''}`);

  if (opts.limit != null) { emails = emails.slice(0, opts.limit); console.log(`  --limit ${opts.limit}: verifying only the first ${emails.length} this run`); }

  const need = emails.length;
  if (credits >= 0 && need > credits) {
    console.log(`\n  ⚠️  need ${need} credits but only ${credits} available. The run will verify what it can, then stop and`);
    console.log('      report — top up ZeroBounce (or enable auto-refill) and re-run to resume the rest.');
  }

  if (!opts.apply) {
    console.log('\n--- optional first step ---');
    console.log(`  --reset would set email_status -> "not_checked" on every un-verified row (and "no_email" on blank ones)`);
    console.log('    so the field never misleadingly reads Apollo\'s "verified" before we\'ve checked it.');
    console.log('\nDRY RUN — nothing verified, nothing written, 0 credits spent.');
    console.log('Re-run with --apply to verify + write (add --reset to blank the field first, --limit N for a test batch).\n');
    return;
  }

  // ---- optional reset pass: mark everything not-yet-checked as not_checked / no_email ----
  if (opts.reset) {
    const resetUpdates = records
      .filter((r) => !r.fields[VERIFIED_DATE])
      .map((r) => ({ id: r.id, fields: { email_status: normEmail(r.fields.email) ? 'not_checked' : 'no_email' } }));
    console.log(`\nReset: writing "not_checked"/"no_email" to ${resetUpdates.length} un-verified record(s)…`);
    await updateLeads(table, resetUpdates);
    console.log('  reset done.');
  } else {
    // Even without --reset, stamp the blank-email rows so they read no_email rather than "verified".
    if (blankNoDate.length) {
      await updateLeads(table, blankNoDate.map((r) => ({ id: r.id, fields: { email_status: 'no_email' } })));
      console.log(`\nMarked ${blankNoDate.length} blank-email row(s) as no_email.`);
    }
  }

  // ---- verify pass: chunk so results are written incrementally (durable + resumable) ----
  console.log(`\nVerifying ${need} distinct email(s)…`);
  const CHUNK = 100;
  const tally = new Map<string, number>();
  let verified = 0;
  let creditsOut = false;

  for (let i = 0; i < emails.length && !creditsOut; i += CHUNK) {
    const slice = emails.slice(i, i + CHUNK);
    const results = await mapPool(slice, opts.concurrency, async (email) => {
      try {
        return { email, res: await zb.validateEmail(email) };
      } catch (err) {
        if (err instanceof zb.InsufficientCreditsError) { creditsOut = true; return null; }
        console.log(`    ! ${email}: ${(err as Error).message}`);
        return null; // leave this email un-stamped so a future run retries it
      }
    });

    const updates: { id: string; fields: Record<string, unknown> }[] = [];
    for (const r of results) {
      if (!r) continue;
      tally.set(r.res.status, (tally.get(r.res.status) ?? 0) + 1);
      for (const id of byEmail.get(r.email) ?? []) {
        updates.push({ id, fields: { email_status: r.res.status, [SUB_STATUS]: r.res.subStatus, [VERIFIED_DATE]: r.res.processedDate } });
      }
    }
    if (updates.length) await updateLeads(table, updates);
    verified += results.filter(Boolean).length;
    console.log(`  …${Math.min(i + CHUNK, emails.length)}/${emails.length} emails checked (${verified} written)`);
  }

  console.log('\n--- results by status ---');
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}`);

  if (creditsOut) {
    const remaining = need - verified;
    console.log(`\n⛔ ZeroBounce ran out of credits — verified ${verified} of ${need} this run; ${remaining} still to do.`);
    console.log('   Auto-refill did not cover it. Top up ZeroBounce (or enable auto-refill) and re-run the same');
    console.log('   command — it resumes from where it stopped (already-verified rows are skipped).\n');
  } else {
    console.log(`\n✓ done — verified ${verified} distinct email(s); email_status/${SUB_STATUS}/${VERIFIED_DATE} updated.`);
    console.log(`  remaining ZeroBounce credits: ${await zb.getCredits()}\n`);
  }
}

// ---------------- export approved leads to CSV ----------------

/** Column order for the exported CSV. Columns the table doesn't have are left out. */
const EXPORT_COLUMNS = [
  'full_name', 'first_name', 'last_name', 'title', 'email', 'email_status', SUB_STATUS, VERIFIED_DATE,
  'company', 'domain', 'website', 'employees', 'industry', 'linkedin_url', 'city', 'state', 'country',
  'seniority', 'departments', 'apollo_person_id', 'apollo_org_id', 'source', 'search_name',
] as const;

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export interface ExportOpts {
  table: LeadTable;
  /** email_status values to include (approved set). */
  statuses: string[];
  out: string;
}

export async function exportApproved(opts: ExportOpts): Promise<void> {
  const { table, statuses, out } = opts;
  const fs = await import('node:fs');
  console.log(`\n=== EXPORT APPROVED LEADS -> CSV ===`);
  console.log(`${table} · approved statuses: ${statuses.join(', ')}\n`);

  await requireColumns(table, ['email_status']);
  const have = await tableColumns(table);
  const columns: string[] = EXPORT_COLUMNS.filter((c) => have.has(c));
  console.log('Reading approved records from the database…');
  const records = await fetchLeads(table, {
    columns,
    where: { sql: 'email_status = ANY($1::text[])', params: [statuses] },
  });
  console.log(`  ${records.length} approved records`);

  const header = columns.join(',');
  const lines = records.map((r) => columns.map((c) => csvCell(r.fields[c])).join(','));
  fs.writeFileSync(out, [header, ...lines].join('\n') + '\n');

  const bytes = fs.statSync(out).size;
  console.log(`\n✓ wrote ${records.length} leads to ${out} (${(bytes / 1024).toFixed(0)} KB)`);
  console.log(`  columns: ${columns.join(', ')}\n`);
}
