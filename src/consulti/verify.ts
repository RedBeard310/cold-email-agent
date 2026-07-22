// Verify un-checked Airtable emails with Consulti's verification API (POST /verify, 1 credit).
//
// Companion to the ZeroBounce flow (src/verify/emails.ts) and the standing path for future
// Consulti tranches: consulti:to-airtable stamps new imports email_status='not_checked', and
// those get verified here with Consulti's own verification credits (Casey's call, 2026-07-22)
// instead of ZeroBounce.
//
// Same safety model as the ZB flow: dry-run by default (--apply gates all spend + writes),
// resumable (rows carrying email_verified_date are skipped; each chunk writes incrementally),
// distinct emails verified once and fanned out to duplicate rows. The status map keeps the
// niche segmentFormula ({email_status}='valid') working: good->valid, bad->invalid,
// risky->risky, unknown->unknown. `unknown` is transient per Consulti docs, so it gets NO
// date stamp — the next run picks it up again. Catch-all/role/disposable flags land in
// email_sub_status only — this command records verdicts, it never rejects leads (freemail is
// NEVER treated specially — hard rule). The 5-credit /verify/catchall endpoint is never called.

import { fetchRecords } from '../engine/airtable';
import { ensureSchema, writeUpdates, mapPool, VERIFIED_DATE, SUB_STATUS } from '../verify/emails';
import { getCredits, verifyEmail, InsufficientCreditsError } from './client';

/** Consulti verdict -> our email_status vocabulary (shared with the ZB flow). */
const STATUS_MAP: Record<string, string> = { good: 'valid', bad: 'invalid', risky: 'risky', unknown: 'unknown' };

const normEmail = (v: unknown): string => String(v ?? '').trim().toLowerCase();

export interface ConsultiVerifyOpts {
  baseId: string;
  table: string;
  apply: boolean;
  limit: number | null;
  concurrency: number;
}

export async function consultiVerify(opts: ConsultiVerifyOpts): Promise<void> {
  const { baseId, table } = opts;
  console.log(`\n=== CONSULTI VERIFY — ${opts.apply ? 'APPLY (writes to Airtable + spends verification credits)' : 'DRY RUN (no verify calls, no writes)'} ===`);
  console.log(`base ${baseId} / "${table}"${opts.limit != null ? ` · limit ${opts.limit} distinct emails` : ''} · concurrency ${opts.concurrency}\n`);

  const credits = await getCredits();
  console.log(`Consulti verification credits available: ${credits.verification_credits}`);

  console.log('\nEnsuring schema…');
  const { tableId } = await ensureSchema(baseId, table, opts.apply);

  // Only the rows this command owns: never-checked imports, plus transient `unknown` verdicts
  // that were deliberately left un-dated so they retry here.
  const formula = `OR({email_status}='not_checked', AND({email_status}='unknown', {${VERIFIED_DATE}}=BLANK()))`;
  console.log('\nReading un-verified records from Airtable…');
  const records = await fetchRecords(baseId, table, {
    filterByFormula: formula,
    fields: ['email', 'email_status', VERIFIED_DATE],
  });
  console.log(`  ${records.length} record(s) matching`);

  // Distinct un-verified emails -> the record ids that carry them.
  const byEmail = new Map<string, string[]>();
  for (const r of records) {
    const e = normEmail(r.fields.email);
    if (!e) continue;
    if (r.fields[VERIFIED_DATE]) continue; // stamped by a prior run — resume past it
    (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(r.id);
  }

  let emails = [...byEmail.keys()];
  console.log(`  ${emails.length} distinct email(s) to verify`);
  if (opts.limit != null) { emails = emails.slice(0, opts.limit); console.log(`  --limit ${opts.limit}: verifying only the first ${emails.length} this run`); }

  const need = emails.length;
  if (need === 0) {
    console.log('\n✓ nothing to verify — no not_checked/undated-unknown rows.\n');
    return;
  }
  if (need > credits.verification_credits) {
    console.log(`\n  ⚠️  need ${need} credits but only ${credits.verification_credits} available — the run verifies what it can, then stops (resumable).`);
  }

  if (!opts.apply) {
    console.log(`\nDRY RUN — would verify ${need} distinct email(s) (${need} credits). Re-run with --apply to verify + write.\n`);
    return;
  }

  // ---- verify pass: chunk so results are written incrementally (durable + resumable) ----
  console.log(`\nVerifying ${need} distinct email(s)…`);
  const CHUNK = 100;
  const today = new Date().toISOString().slice(0, 10);
  const tally = new Map<string, number>();
  let verified = 0;
  let creditsOut = false;

  for (let i = 0; i < emails.length && !creditsOut; i += CHUNK) {
    const slice = emails.slice(i, i + CHUNK);
    const results = await mapPool(slice, opts.concurrency, async (email) => {
      try {
        return { email, res: await verifyEmail(email) };
      } catch (err) {
        if (err instanceof InsufficientCreditsError) { creditsOut = true; return null; }
        console.log(`    ! ${email}: ${(err as Error).message}`);
        return null; // left un-stamped so a future run retries it
      }
    });

    const updates: { id: string; fields: Record<string, unknown> }[] = [];
    for (const r of results) {
      if (!r) continue;
      const status = STATUS_MAP[r.res.status] ?? 'unknown';
      tally.set(status, (tally.get(status) ?? 0) + 1);
      const subStatus = ['consulti', r.res.isCatchAll && 'catch_all', r.res.isRoleAccount && 'role_account', r.res.isDisposable && 'disposable']
        .filter(Boolean)
        .join(',');
      for (const id of byEmail.get(r.email) ?? []) {
        updates.push({
          id,
          fields: {
            email_status: status,
            [SUB_STATUS]: subStatus,
            // unknown = transient upstream (per docs) — no date stamp, so the next run retries it.
            ...(status !== 'unknown' && { [VERIFIED_DATE]: today }),
          },
        });
      }
    }
    if (updates.length) await writeUpdates(baseId, tableId, updates);
    verified += results.filter(Boolean).length;
    console.log(`  …${Math.min(i + CHUNK, emails.length)}/${emails.length} emails checked (${verified} written)`);
  }

  console.log('\n--- results by status ---');
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}`);

  if (creditsOut) {
    console.log(`\n⛔ Consulti verification credits exhausted — verified ${verified} of ${need}; top up and re-run to resume.\n`);
  } else {
    const after = await getCredits();
    console.log(`\n✓ done — verified ${verified} distinct email(s). Remaining verification credits: ${after.verification_credits}\n`);
  }
}
