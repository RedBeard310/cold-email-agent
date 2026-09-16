// Apollo export -> Postgres ingestion. Upserts the enriched CSV rows into the niche lead table named
// with --table. There's no default table, because this writes to live leads. A row whose
// apollo_person_id, or failing that its email, matches an existing lead updates that lead, and every
// other row is inserted, so re-running never makes duplicates.
//
// What an update leaves alone (the keep rules):
//   - A checked email. If the lead has an email_verified_date, its email and email_status stay as
//     they are. Apollo's labels (verified, extrapolated, unavailable) never equal ZeroBounce's
//     'valid', so writing one would take the lead off the send list. verify:emails skips rows that
//     already have a date, so it would never put the status back.
//   - Another source's labels. If the lead's source isn't 'apollo' (for example a Consulti lead
//     matched by email), its source, search_name and email_status stay as they are.
//   - A name the lead already has. A first_name or last_name that isn't empty stays as it is.
//     consulti:prune corrects first names to match the inbox owner, and the CSV still holds the old one.
// Everything else the CSV carries (title, company, location, Apollo ids) is written.
//
// What a load never adds:
//   - A lead that consulti:prune deleted. A new row whose email a prune archive lists is skipped (see
//     src/consulti/prune-archive.ts). With no archive in the current folder, the load stops before
//     writing anything unless --skip-prune-check is passed.
//   - A second row with an email another row in the same load already writes. The first row wins.
//     Writing both would break the unique email index and roll back the whole load.
//
// Why both keys: the table has a unique index on apollo_person_id and another on email. Consulti
// rows carry no Apollo id and merge on email, so an Apollo row whose email a Consulti row already
// holds has to update that row. Inserting it would break the email index.
//
// This is the marketing-agencies niche's stand-in for an upstream lead-finder repo: the Apollo
// export IS the lead source, so ingestion lives here rather than in a separate producer.
// Tables and columns come from the SQL files in migrations/, never from this code.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pruneCheckRefusal, readPruneArchive } from '../consulti/prune-archive';
import { fetchLeads, requireColumns, upsertLeads, type LeadRow, type LeadTable } from '../engine/db';

// ---------------- CSV -> records ----------------

/** Minimal RFC-4180 CSV parse (handles quoted commas, quotes, embedded newlines). */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows[0] ?? [];
  return rows.slice(1).filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function readAllRows(key: string): Record<string, string>[] {
  const dir = path.join('.apollo', key);
  const files = fs.readdirSync(dir).filter((n) => /^part-\d+\.csv$/.test(n)).sort();
  const all: Record<string, string>[] = [];
  for (const f of files) all.push(...parseCsv(fs.readFileSync(path.join(dir, f), 'utf8')));
  return all;
}

function toFields(r: Record<string, string>, searchName: string): Record<string, unknown> {
  // Stored emails are lowercase and trimmed, and the unique email index is case-sensitive, so a
  // mixed-case copy of an existing email would otherwise become a second row.
  const email = (r.email ?? '').trim().toLowerCase();
  const full = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || email || r.company || '(unknown)';
  const emp = Number(r.employees);
  const f: Record<string, unknown> = {
    full_name: full,
    first_name: r.first_name || undefined,
    last_name: r.last_name || undefined,
    title: r.title || undefined,
    company: r.company || undefined,
    domain: r.website || undefined,
    industry: r.industry || undefined,
    linkedin_url: r.linkedin_url || undefined,
    city: r.city || undefined,
    state: r.state || undefined,
    country: r.country || undefined,
    seniority: r.seniority || undefined,
    departments: r.departments || undefined,
    apollo_person_id: r.apollo_person_id || undefined,
    apollo_org_id: r.apollo_org_id || undefined,
    source: 'apollo',
    search_name: searchName,
  };
  if (email) f.email = email;
  if (r.email_status) f.email_status = r.email_status;
  if (r.website) f.website = `https://${r.website}`;
  if (r.employees && Number.isFinite(emp)) f.employees = Math.round(emp); // bigint column
  return f;
}

/** The CSV rows as lead rows, one per apollo_person_id (or per email when a row has no id). The first
 *  row wins. A row with neither is dropped, because nothing could match it on a re-run. */
export function toRecords(rows: Record<string, string>[], searchName: string): {
  records: Record<string, unknown>[];
  dupes: number;
  noEmail: number;
  noKey: number;
} {
  const seen = new Set<string>();
  const records: Record<string, unknown>[] = [];
  let noEmail = 0;
  let dupes = 0;
  let noKey = 0;
  for (const r of rows) {
    const email = (r.email ?? '').trim().toLowerCase();
    const dedup = r.apollo_person_id || email;
    if (!dedup) { noKey++; continue; }
    if (seen.has(dedup)) { dupes++; continue; }
    seen.add(dedup);
    if (!email) noEmail++;
    records.push(toFields(r, searchName));
  }
  return { records, dupes, noEmail, noKey };
}

// ---------------- matching incoming rows to existing leads ----------------

/** The columns of an existing lead that matching and the keep rules read. */
export const MATCH_COLUMNS = ['apollo_person_id', 'email', 'source', 'email_verified_date', 'first_name', 'last_name'];

export interface ExistingLead {
  id: string;
  personId?: string;
  email?: string;
  /** The lead's source column. */
  source?: string;
  /** email_verified_date is set, so this email and its status were already checked. */
  verified?: boolean;
  /** first_name isn't empty, so the CSV's first_name is left out of the update. */
  hasFirstName?: boolean;
  /** last_name isn't empty, so the CSV's last_name is left out of the update. */
  hasLastName?: boolean;
}

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/** An existing lead, read with MATCH_COLUMNS, in the shape resolveTargets takes. */
export function toExistingLead(lead: LeadRow): ExistingLead {
  const f = lead.fields;
  return {
    id: lead.id,
    personId: typeof f.apollo_person_id === 'string' ? f.apollo_person_id : undefined,
    email: typeof f.email === 'string' ? f.email.trim().toLowerCase() : undefined,
    source: typeof f.source === 'string' ? f.source : undefined,
    verified: f.email_verified_date !== undefined, // fetchLeads leaves empty columns out
    hasFirstName: filled(f.first_name),
    hasLastName: filled(f.last_name),
  };
}

const fromApollo = (lead: ExistingLead): boolean => lead.source?.trim().toLowerCase() === 'apollo';

export interface MatchPlan {
  /** Rows to upsert on id. A row with an id updates that lead; a row without one is new. */
  out: Record<string, unknown>[];
  matched: number;
  /** Rows in out without an id: the new leads. */
  added: number;
  ambiguous: string[];
  /** Matched leads with a checked email. Their email and email_status were left out of the update. */
  keptChecked: number;
  /** How many of those the CSV lists with a different email. */
  keptChangedEmail: number;
  /** Matched leads from another source. Their source, search_name and email_status were left out. */
  keptOtherSource: number;
  /** Matched leads that already had a first_name or last_name, so the CSV's was left out. */
  keptNames: number;
  /** New rows whose email a prune archive lists. Left out. */
  skippedPruned: number;
  /** Rows whose email another row in this load already writes. Left out. */
  skippedDuplicateEmail: number;
}

/** Point each incoming row at the lead it should update: the same apollo_person_id first, then the
 *  same email. A row is skipped as ambiguous, never guessed, when its person id and its email belong
 *  to two different leads, or when its email belongs to a lead with a different Apollo id. Each update
 *  leaves out the columns the keep rules at the top of this file protect. A new row is skipped when
 *  `pruned` lists its email (null means the prune check is off). Any row is skipped when an earlier
 *  row already writes its email to a different lead, because both would break the unique email index. */
export function resolveTargets(
  rows: Record<string, unknown>[],
  existing: ExistingLead[],
  pruned: ReadonlySet<string> | null = null,
): MatchPlan {
  const byPerson = new Map<string, ExistingLead>();
  const byEmail = new Map<string, ExistingLead>();
  for (const lead of existing) {
    if (lead.personId) byPerson.set(lead.personId, lead);
    if (lead.email) byEmail.set(lead.email, lead);
  }
  // Who writes each email in this load: a lead id for an update, the row number for a new lead. A
  // second writer with a different owner would give two leads one email.
  const writer = new Map<string, string>();
  const claim = (email: unknown, owner: string): boolean => {
    if (typeof email !== 'string' || !email) return true;
    const prev = writer.get(email);
    if (prev !== undefined && prev !== owner) return false;
    writer.set(email, owner);
    return true;
  };
  const out: Record<string, unknown>[] = [];
  const ambiguous: string[] = [];
  let matched = 0;
  let added = 0;
  let keptChecked = 0;
  let keptChangedEmail = 0;
  let keptOtherSource = 0;
  let keptNames = 0;
  let skippedPruned = 0;
  let skippedDuplicateEmail = 0;
  for (const [i, row] of rows.entries()) {
    const personId = typeof row.apollo_person_id === 'string' ? row.apollo_person_id : '';
    const email = typeof row.email === 'string' ? row.email : '';
    const byId = personId ? byPerson.get(personId) : undefined;
    const byMail = email ? byEmail.get(email) : undefined;
    if (byId && byMail && byId.id !== byMail.id) { ambiguous.push(byId.id); continue; }
    if (!byId && byMail?.personId && personId && byMail.personId !== personId) { ambiguous.push(byMail.id); continue; }
    const target = byId ?? byMail;
    if (!target) {
      if (email && pruned?.has(email)) { skippedPruned++; continue; }
      if (!claim(email, `new row ${i}`)) { skippedDuplicateEmail++; continue; }
      added++;
      out.push(row);
      continue;
    }
    const update: Record<string, unknown> = { ...row, id: target.id };
    const checked = target.verified === true;
    const otherSource = !fromApollo(target);
    if (checked) {
      delete update.email;
      delete update.email_status;
    }
    if (otherSource) {
      delete update.source;
      delete update.search_name;
      delete update.email_status;
    }
    const keepsName = (target.hasFirstName === true && update.first_name !== undefined)
      || (target.hasLastName === true && update.last_name !== undefined);
    if (target.hasFirstName) delete update.first_name;
    if (target.hasLastName) delete update.last_name;
    if (!claim(update.email, target.id)) { skippedDuplicateEmail++; continue; }
    matched++;
    if (checked) {
      keptChecked++;
      if (email && target.email && email !== target.email) keptChangedEmail++;
    }
    if (otherSource) keptOtherSource++;
    if (keepsName) keptNames++;
    out.push(update);
  }
  return { out, matched, added, ambiguous, keptChecked, keptChangedEmail, keptOtherSource, keptNames, skippedPruned, skippedDuplicateEmail };
}

// ---------------- orchestration ----------------

export interface IngestOpts {
  table: LeadTable;
  searchName: string;
  limit?: number; // only upsert the first N records (sample a new load before loading all)
  /** Don't read the prune archives, so a lead consulti:prune deleted can be added again. */
  skipPruneCheck: boolean;
}

export async function ingest(key: string, opts: IngestOpts): Promise<void> {
  console.log(`\n=== Apollo -> ${opts.table}: "${key}" ===`);
  await requireColumns(opts.table, MATCH_COLUMNS);
  const rows = readAllRows(key);
  const { records, dupes, noEmail, noKey } = toRecords(rows, opts.searchName);
  console.log(`  read ${rows.length} rows -> ${records.length} unique (${dupes} dup person-ids skipped, ${noEmail} without email${noKey ? `, ${noKey} with no person id and no email skipped` : ''})`);
  const toLoad = opts.limit != null ? records.slice(0, opts.limit) : records;
  if (opts.limit != null) console.log(`  --limit ${opts.limit}: loading only the first ${toLoad.length} this run`);

  const archive = opts.skipPruneCheck ? null : readPruneArchive();
  console.log(archive
    ? `  prune archives: ${archive.files.length} file(s) in ${archive.dir}, listing ${archive.emails.size} email(s)`
    : '  --skip-prune-check: leads that consulti:prune deleted can be added again');

  const existing = await fetchLeads(opts.table, { columns: MATCH_COLUMNS });
  const plan = resolveTargets(toLoad, existing.map(toExistingLead), archive?.emails ?? null);
  if (plan.ambiguous.length) {
    console.log(`  skipped ${plan.ambiguous.length} row(s) whose person id and email belong to different leads (for example ${plan.ambiguous.slice(0, 3).join(', ')})`);
  }
  if (plan.keptChecked) {
    console.log(`  ${plan.keptChecked} matched lead(s) already have a checked email, so their email and email_status stay as they are${plan.keptChangedEmail ? ` (the CSV lists a different email for ${plan.keptChangedEmail} of them)` : ''}`);
  }
  if (plan.keptOtherSource) {
    console.log(`  ${plan.keptOtherSource} matched lead(s) came from another source, so their source, search_name and email_status stay as they are`);
  }
  if (plan.keptNames) {
    console.log(`  ${plan.keptNames} matched lead(s) already have a first or last name, so that name stays as it is`);
  }
  if (plan.skippedPruned) {
    console.log(`  skipped ${plan.skippedPruned} new row(s) whose email a prune archive lists, because consulti:prune deleted those leads`);
  }
  if (plan.skippedDuplicateEmail) {
    console.log(`  skipped ${plan.skippedDuplicateEmail} row(s) whose email another row in this load already writes`);
  }
  const refusal = pruneCheckRefusal(archive, plan.added);
  if (refusal) {
    console.log(`\n✗ ${refusal}\n`);
    process.exit(1);
  }

  console.log(`  upserting ${plan.out.length} records (${plan.matched} update an existing lead, ${plan.added} are new to this table)…`);
  const { inserted, updated } = await upsertLeads(opts.table, plan.out, 'id');
  console.log(`\n=== done: ${inserted} created, ${updated} updated in ${opts.table} ===\n`);
}
