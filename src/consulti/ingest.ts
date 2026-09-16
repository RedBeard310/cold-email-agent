// Cleaned Consulti CSV -> Postgres. Loads the approved CSV that consulti:clean wrote into the niche
// lead table named with --table. There's no default table, because this writes to live leads. The
// marketing leads share niche_leads.marketing_agencies with the Apollo leads, and the source column
// tells them apart.
//
// A CSV row whose email is already in the table updates that lead. Every other row becomes a new lead
// with email_status 'not_checked', so a verify command (consulti:verify or verify:emails) checks it
// before any send. Re-running never makes duplicates. Matching on email needs a unique email index:
// migration 0002 added one to the seven tables Consulti writes. niche_leads.financial_advisors has
// none, so it can't be a target.
//
// What an update leaves alone (the keep rules):
//   - email_status, source and search_name. Writing 'not_checked' over a checked 'valid' would take
//     the lead off the send list for good, because both verify commands skip any lead that already
//     has an email_verified_date.
//   - A name the lead already has. A first_name or last_name that isn't empty stays as it is.
//     consulti:prune corrects first names to match the inbox owner, and the CSV still holds the old one.
// Everything else the CSV carries (title, company, location, segment and so on) is written.
//
// What a load never adds:
//   - A lead that consulti:prune deleted. A new row whose email a prune archive lists is skipped (see
//     prune-archive.ts). With no archive in the current folder, the load stops before writing
//     anything unless --skip-prune-check is passed.
//   - A second row with the same email. The first row wins.
import fs from 'node:fs';
import { fetchLeads, requireColumns, requireUniqueColumn, upsertLeads, type LeadRow, type LeadTable } from '../engine/db';
import { pruneCheckRefusal, readPruneArchive } from './prune-archive';
import { parseCsv } from './pull';

/** One approved CSV row as lead columns. */
export function toFields(r: Record<string, string>): Record<string, unknown> {
  // Stored emails are lowercase and trimmed, and the unique email index is case-sensitive.
  const email = (r.email ?? '').trim().toLowerCase();
  const full = r.full_name || `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || email || '(unknown)';
  const emp = Number(r.employees);
  const f: Record<string, unknown> = {
    full_name: full,
    first_name: r.first_name || undefined,
    last_name: r.last_name || undefined,
    title: r.title || undefined,
    email,
    email_status: 'not_checked',
    company: r.company || undefined,
    domain: r.domain || undefined,
    industry: r.industry || undefined,
    linkedin_url: r.linkedin_url || undefined,
    city: r.city || undefined,
    state: r.state || undefined,
    country: r.country || undefined,
    source: r.source || 'consulti',
    search_name: r.search_name || undefined,
  };
  if (r.website) f.website = r.website;
  if (r.employees && Number.isFinite(emp)) f.employees = Math.round(emp); // bigint column
  if (r.segment) f.segment = r.segment; // advisors ruleset: independent | bd_affiliated
  return f;
}

// ---------------- matching incoming rows to existing leads ----------------

/** The columns of an existing lead that matching and the keep rules read. */
export const MATCH_COLUMNS = ['email', 'first_name', 'last_name'];

/** Columns a matched lead never takes from the CSV. email is the match key, so it's already the same. */
const KEPT_ON_UPDATE = ['email', 'email_status', 'source', 'search_name'];

export interface ExistingLead {
  id: string;
  email?: string;
  /** first_name isn't empty, so the CSV's first_name is left out of the update. */
  hasFirstName: boolean;
  /** last_name isn't empty, so the CSV's last_name is left out of the update. */
  hasLastName: boolean;
}

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/** An existing lead, read with MATCH_COLUMNS, in the shape planLoad takes. */
export function toExistingLead(lead: LeadRow): ExistingLead {
  const f = lead.fields;
  return {
    id: lead.id,
    email: typeof f.email === 'string' ? f.email.trim().toLowerCase() : undefined,
    hasFirstName: filled(f.first_name),
    hasLastName: filled(f.last_name),
  };
}

export interface LoadPlan {
  /** Rows to upsert on id. A row with an id updates that lead; a row without one is a new lead. */
  out: Record<string, unknown>[];
  matched: number;
  added: number;
  /** Matched leads that already had a first_name or last_name, so the CSV's was left out. */
  keptNames: number;
  /** New rows whose email a prune archive lists. Left out. */
  skippedPruned: number;
  /** Rows whose email an earlier row already has. Left out. */
  duplicates: number;
}

/** Match each row to the lead with the same email and apply the keep rules to the update. A new row is
 *  skipped when `pruned` lists its email (null means the prune check is off), and any row is skipped
 *  when an earlier row has the same email. */
export function planLoad(
  rows: Record<string, unknown>[],
  existing: ExistingLead[],
  pruned: ReadonlySet<string> | null,
): LoadPlan {
  const byEmail = new Map<string, ExistingLead>();
  for (const lead of existing) if (lead.email) byEmail.set(lead.email, lead);
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  let matched = 0;
  let added = 0;
  let keptNames = 0;
  let skippedPruned = 0;
  let duplicates = 0;
  for (const row of rows) {
    const email = typeof row.email === 'string' ? row.email : '';
    if (!email) continue; // toDb drops rows without an email before this
    if (seen.has(email)) { duplicates++; continue; }
    seen.add(email);
    const target = byEmail.get(email);
    if (!target) {
      if (pruned?.has(email)) { skippedPruned++; continue; }
      added++;
      out.push(row);
      continue;
    }
    matched++;
    const update: Record<string, unknown> = { ...row, id: target.id };
    for (const column of KEPT_ON_UPDATE) delete update[column];
    if ((target.hasFirstName && update.first_name !== undefined) || (target.hasLastName && update.last_name !== undefined)) keptNames++;
    if (target.hasFirstName) delete update.first_name;
    if (target.hasLastName) delete update.last_name;
    out.push(update);
  }
  return { out, matched, added, keptNames, skippedPruned, duplicates };
}

// ---------------- orchestration ----------------

export interface ToDbOpts {
  file: string;
  table: LeadTable;
  limit?: number; // only load the first N rows (sample a new load before loading all)
  /** Don't read the prune archives, so a lead consulti:prune deleted can be added again. */
  skipPruneCheck: boolean;
}

export async function toDb(opts: ToDbOpts): Promise<void> {
  console.log(`\n=== Consulti -> ${opts.table}: ${opts.file} ===`);
  await requireColumns(opts.table, MATCH_COLUMNS);
  await requireUniqueColumn(opts.table, 'email');
  const rows = parseCsv(fs.readFileSync(opts.file, 'utf8')).filter((r) => r.email?.trim());
  const toLoad = opts.limit != null ? rows.slice(0, opts.limit) : rows;
  console.log(`  read ${rows.length} rows with an email`);
  if (opts.limit != null) console.log(`  --limit ${opts.limit}: loading only the first ${toLoad.length} this run`);

  const archive = opts.skipPruneCheck ? null : readPruneArchive();
  console.log(archive
    ? `  prune archives: ${archive.files.length} file(s) in ${archive.dir}, listing ${archive.emails.size} email(s)`
    : '  --skip-prune-check: leads that consulti:prune deleted can be added again');

  const existing = await fetchLeads(opts.table, { columns: MATCH_COLUMNS });
  const plan = planLoad(toLoad.map(toFields), existing.map(toExistingLead), archive?.emails ?? null);
  if (plan.duplicates) console.log(`  skipped ${plan.duplicates} row(s) whose email an earlier row already has`);
  if (plan.matched) {
    console.log(`  ${plan.matched} row(s) match a lead already in the table, so those leads keep their email_status, source and search_name`);
  }
  if (plan.keptNames) console.log(`  ${plan.keptNames} of those leads already have a first or last name, so that name stays as it is`);
  if (plan.skippedPruned) {
    console.log(`  skipped ${plan.skippedPruned} new row(s) whose email a prune archive lists, because consulti:prune deleted those leads`);
  }
  const refusal = pruneCheckRefusal(archive, plan.added);
  if (refusal) {
    console.log(`\n✗ ${refusal}\n`);
    process.exit(1);
  }

  console.log(`  upserting ${plan.out.length} records (${plan.matched} update an existing lead, ${plan.added} are new to this table)…`);
  const { inserted, updated } = await upsertLeads(opts.table, plan.out, 'id');
  console.log(`Done: ${inserted} created, ${updated} updated.`);
}
