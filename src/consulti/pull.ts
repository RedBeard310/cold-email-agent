// Cursored tranche pull from a named Consulti search spec (see searches.ts — the pool is
// walked as SLICES in declared order, so the best/most-wanted credits are spent first).
//
// A cursor in .consulti/state.json remembers the next page per slice; re-running continues
// where the last tranche stopped. Consulti inserts new leads over time so page boundaries
// drift between runs — the email-level dedupe (within and across a search's raw CSVs)
// absorbs that; drifted duplicates are still billed by Consulti but never re-exported.
import fs from 'node:fs';
import path from 'node:path';
import { searchLeads, getCredits, type ConsultiLead } from './client';
import { getSearch, SEARCHES, type SearchSpec } from './searches';

const OUT_DIR = '.consulti';
const STATE_FILE = path.join(OUT_DIR, 'state.json');
const PAGE_SIZE = 100; // API max

interface SliceState { nextPage: number; exhausted: boolean; pulled: number }
type State = Record<string, SliceState>;

function loadState(): State {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State;
}
function saveState(s: State): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ---------------- CSV (same column set as the Apollo export so Airtable ingest is uniform) ----------------

export const COLUMNS = [
  'full_name', 'first_name', 'last_name', 'title', 'email', 'email_status', 'email_sub_status',
  'email_verified_date', 'company', 'domain', 'website', 'employees', 'industry', 'linkedin_url',
  'city', 'state', 'country', 'seniority', 'departments', 'apollo_person_id', 'apollo_org_id',
  'source', 'search_name',
] as const;

function row(p: ConsultiLead, searchName: string, slice: string): Record<string, string> {
  const first = p.first_name ?? '';
  const last = p.last_name ?? '';
  const domain = (p.company_domain ?? p.email.split('@')[1] ?? '').toLowerCase().replace(/^www\./, '');
  return {
    full_name: [first, last].filter(Boolean).join(' '),
    first_name: first,
    last_name: last,
    title: p.job_title ?? '',
    email: p.email.trim().toLowerCase(),
    email_status: p.email_status ?? '',
    email_sub_status: '',
    email_verified_date: '',
    company: p.company_name ?? '',
    domain,
    website: domain ? `https://${domain}` : '',
    employees: p.employees != null ? String(p.employees) : '',
    industry: p.industry ?? '',
    linkedin_url: p.linkedin_url ?? '',
    city: p.city ?? '',
    state: p.state ?? '',
    country: p.country ?? '',
    seniority: '',
    departments: '',
    apollo_person_id: '',
    apollo_org_id: '',
    source: 'consulti',
    search_name: `${searchName} [${slice}]`,
  };
}

export const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvLine = (vals: string[]) => vals.map(csvCell).join(',');

export function writeCsv(file: string, rows: Record<string, string>[]): void {
  const lines = [csvLine([...COLUMNS]), ...rows.map((r) => csvLine(COLUMNS.map((c) => r[c] ?? '')))];
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function appendRows(file: string, rows: Record<string, string>[]): void {
  if (!rows.length) return;
  fs.appendFileSync(file, rows.map((r) => csvLine(COLUMNS.map((c) => r[c] ?? ''))).join('\n') + '\n');
}

/** Minimal quoted-field CSV parser (handles commas/quotes/newlines inside quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '', rowAcc: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { rowAcc.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      rowAcc.push(field); field = '';
      if (rowAcc.some((f) => f !== '')) rows.push(rowAcc);
      rowAcc = [];
    } else field += c;
  }
  if (field !== '' || rowAcc.length) { rowAcc.push(field); if (rowAcc.some((f) => f !== '')) rows.push(rowAcc); }
  const [header, ...data] = rows;
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** Emails already pulled in this search's prior raw CSVs — never export a lead twice across
 *  tranches. Scoped by rawPrefix so one search's dedupe never hides a lead from another;
 *  files claimed by another spec's longer prefix (marketing's bare "raw-" would otherwise
 *  swallow "raw-advisors-…") are excluded. */
function priorEmails(spec: SearchSpec): Set<string> {
  const seen = new Set<string>();
  if (!fs.existsSync(OUT_DIR)) return seen;
  const otherPrefixes = SEARCHES.filter((s) => s.key !== spec.key && s.rawPrefix.length > spec.rawPrefix.length)
    .map((s) => s.rawPrefix);
  const mine = (n: string) =>
    n.startsWith(spec.rawPrefix) && n.endsWith('.csv') && !otherPrefixes.some((p) => n.startsWith(p));
  for (const f of fs.readdirSync(OUT_DIR).filter(mine)) {
    for (const r of parseCsv(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'))) {
      if (r.email) seen.add(r.email.toLowerCase());
    }
  }
  return seen;
}

// ---------------- pull ----------------

export async function pull(opts: { search: string; count: number; slice?: string }): Promise<void> {
  const spec = getSearch(opts.search);
  if (opts.slice && !spec.slices.some((s) => s.key === opts.slice)) {
    console.log(`unknown --slice "${opts.slice}" for search "${spec.key}" (valid: ${spec.slices.map((s) => s.key).join(', ')})`);
    process.exit(1);
  }

  const before = await getCredits();
  console.log(`Search "${spec.key}" — credits before: ${before.lead_credits} lead / ${before.verification_credits} verification`);
  if (before.lead_credits < opts.count) {
    console.log(`Not enough lead credits for --count ${opts.count}. Aborting before any spend.`);
    process.exit(1);
  }

  const state = loadState();
  const seen = priorEmails(spec);
  const slices = opts.slice ? spec.slices.filter((s) => s.key === opts.slice) : spec.slices;
  let dupSkipped = 0;
  let written = 0;

  // Open the raw CSV up front and append after every page, so a mid-run crash (network, 402)
  // never loses already-billed rows — the file and the cursor stay in lockstep.
  const stamp = new Date().toISOString().slice(0, 10);
  let file = path.join(OUT_DIR, `${spec.rawPrefix}${stamp}.csv`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(OUT_DIR, `${spec.rawPrefix}${stamp}-${n}.csv`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(file, [...COLUMNS].join(',') + '\n');

  for (const slice of slices) {
    if (written >= opts.count) break;
    const ss: SliceState = state[slice.key] ?? { nextPage: 1, exhausted: false, pulled: 0 };
    state[slice.key] = ss;
    if (ss.exhausted) { console.log(`[${slice.key}] exhausted in a prior run, skipping`); continue; }

    while (written < opts.count) {
      const want = Math.min(PAGE_SIZE, opts.count - written);
      const { leads } = await searchLeads(slice.filters, ss.nextPage, want);
      const pageRows: Record<string, string>[] = [];
      for (const p of leads) {
        const email = p.email?.trim().toLowerCase();
        if (!email) continue;
        if (seen.has(email)) { dupSkipped++; continue; }
        seen.add(email);
        pageRows.push(row(p, spec.name, slice.key));
      }
      appendRows(file, pageRows);
      written += pageRows.length;
      ss.pulled += leads.length;
      ss.nextPage++;
      saveState(state); // after every page: a crash never loses paid rows' position
      console.log(`[${slice.key}] page ${ss.nextPage - 1}: +${leads.length} rows (tranche total ${written})`);
      if (leads.length < want) { ss.exhausted = true; saveState(state); console.log(`[${slice.key}] pool exhausted`); break; }
    }
  }

  const after = await getCredits();
  console.log(`\nWrote ${written} leads -> ${file}` + (dupSkipped ? ` (${dupSkipped} cross-tranche duplicates skipped)` : ''));
  console.log(`Credits after: ${after.lead_credits} lead (spent ${before.lead_credits - after.lead_credits})`);

  // Mirror this tranche into the off-machine "already exported" ledger (free; recovery only).
  // Never let a ledger hiccup fail a pull whose rows are already safely on disk.
  try {
    const { pushToLedger, LEDGER_NAME } = await import('./ledger');
    const emails = parseCsv(fs.readFileSync(file, 'utf8')).map((r) => r.email ?? '');
    const { added } = await pushToLedger(emails);
    console.log(`Ledger "${LEDGER_NAME}": +${added} emails mirrored.`);
  } catch (e) {
    console.warn(`WARNING: ledger mirror failed (pull is fine, rows are on disk): ${(e as Error).message}`);
    console.warn(`  Re-sync later with: npm run cea -- consulti:ledger --backfill`);
  }

  console.log(`Next: npm run cea -- consulti:clean --file ${file}`);
}

export async function credits(): Promise<void> {
  const c = await getCredits();
  console.log(`Consulti credits: ${c.lead_credits} lead / ${c.verification_credits} verification`);
}
