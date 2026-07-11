// Apollo saved-search -> enriched-lead CSV export.
//
// Flow (see client.ts for why it's two steps):
//   1. collectIds  — page through the FREE obfuscated search, dedupe person ids, cache to disk.
//   2. exportSearch — enrich cached ids in files of 1,000 (bulk_match, 10/call), write CSVs.
//      Credit-spending. Resumable: a file that already exists on disk is skipped unless --force.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SEARCHES, parseApolloUrl } from './searches';
import { bulkMatch, searchPage, MAX_SEARCH_DEPTH, SEARCH_PAGE_SIZE, type EnrichedPerson, type SearchFilters } from './client';

const OUT_ROOT = '.apollo';
const FILE_SIZE = 1000; // enriched rows per CSV (mirrors Apollo's UI 1k-per-export mental model)
const ENRICH_BATCH = 10; // bulk_match hard cap
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resolveSearch(keyOrName: string) {
  const s = SEARCHES[keyOrName];
  if (!s) throw new Error(`unknown search "${keyOrName}". Known: ${Object.keys(SEARCHES).join(', ') || '(none)'}`);
  return s;
}

interface IdCache {
  collectedAt: string;
  total_entries: number;
  ids: string[];
}
const idCachePath = (key: string) => path.join(OUT_ROOT, `${key}.ids.json`);

/** Page one (segment of a) search to exhaustion, adding ids to `seen`. Returns that segment's total. */
async function pageSegment(filters: SearchFilters, seen: Set<string>, label: string): Promise<number> {
  const first = await searchPage(filters, 1);
  const total = first.total_entries;
  const reachable = Math.min(total, MAX_SEARCH_DEPTH);
  const pages = Math.ceil(reachable / SEARCH_PAGE_SIZE);
  if (total > MAX_SEARCH_DEPTH) console.log(`  ⚠ ${label}: ${total} exceeds the ${MAX_SEARCH_DEPTH} depth cap — split further.`);
  const before = seen.size;
  first.people.forEach((p) => p.id && seen.add(p.id));
  for (let page = 2; page <= pages; page++) {
    const r = await searchPage(filters, page);
    if (r.people.length === 0) break;
    r.people.forEach((p) => p.id && seen.add(p.id));
    await sleep(120);
  }
  console.log(`  ${label.padEnd(34)} total ${String(total).padStart(5)} | +${seen.size - before} new (union ${seen.size})`);
  return total;
}

/**
 * Collect all person ids for a search (free), dedupe, cache to disk. If the search declares
 * `collectionSegments`, page each disjoint slice (avoids relevance-sort pagination drift) and
 * union. `passes` re-runs collection to mop up any residual drift (union grows, then plateaus).
 */
export async function collectIds(key: string, opts: { refresh?: boolean; passes?: number } = {}): Promise<IdCache> {
  const cacheFile = idCachePath(key);
  if (!opts.refresh && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as IdCache;
    console.log(`  id cache: ${cached.ids.length} ids (collected ${cached.collectedAt}) — use --refresh to re-pull`);
    return cached;
  }
  const { filters, name, collectionSegments } = resolveSearch(key);
  const grandTotal = (await searchPage(filters, 1, 1)).total_entries;
  const segments = collectionSegments?.length ? collectionSegments : [{}];
  console.log(`  "${name}": ${grandTotal} total across ${segments.length} segment(s); collecting…`);

  const seen = new Set<string>();
  const passes = Math.max(1, opts.passes ?? (collectionSegments?.length ? 2 : 1));
  for (let pass = 1; pass <= passes; pass++) {
    const before = seen.size;
    if (passes > 1) console.log(`  --- pass ${pass}/${passes} ---`);
    for (const seg of segments) await pageSegment({ ...filters, ...seg }, seen, JSON.stringify(seg) || '(whole)');
    if (pass > 1 && seen.size - before < 5) { console.log(`  pass ${pass} added <5 new — converged.`); break; }
  }

  const ids = [...seen];
  const gap = grandTotal - ids.length;
  console.log(gap > 20
    ? `  ⚠ collected ${ids.length} unique of ${grandTotal} (${gap} short — try --refresh with more passes)`
    : `  ✓ collected ${ids.length} unique of ${grandTotal}`);
  const cache: IdCache = { collectedAt: new Date().toISOString(), total_entries: grandTotal, ids };
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  console.log(`  cached ${ids.length} ids -> ${cacheFile}`);
  return cache;
}

/**
 * Person ids already enriched in prior runs — read back from existing part-*.csv so we never
 * re-charge. The last two columns (apollo_person_id, apollo_org_id) are bare hex ids: never
 * empty-with-commas, never quoted. So the 2nd-from-last comma token is the person id regardless
 * of quoted commas in earlier fields (titles, company names) — no full CSV parse needed.
 */
function loadEnrichedIds(key: string): Set<string> {
  const dir = path.join(OUT_ROOT, key);
  const done = new Set<string>();
  if (!fs.existsSync(dir)) return done;
  for (const f of fs.readdirSync(dir).filter((n) => /^part-\d+\.csv$/.test(n))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const cells = line.split(',');
      const id = cells[cells.length - 2]; // apollo_person_id
      if (id && /^[a-f0-9]{16,}$/.test(id)) done.add(id); // hex id shape guards against stray fragments
    }
  }
  return done;
}

// ---------------- CSV ----------------

const COLUMNS = [
  'first_name', 'last_name', 'title', 'email', 'email_status',
  'company', 'website', 'employees', 'industry',
  'linkedin_url', 'city', 'state', 'country', 'seniority', 'departments',
  'apollo_person_id', 'apollo_org_id',
] as const;

function row(p: EnrichedPerson): Record<(typeof COLUMNS)[number], string> {
  const org = p.organization ?? {};
  return {
    first_name: p.first_name ?? '',
    last_name: p.last_name ?? '',
    title: p.title ?? '',
    email: p.email ?? '',
    email_status: p.email_status ?? '',
    company: org.name ?? '',
    website: org.primary_domain ?? org.website_url ?? '',
    employees: org.estimated_num_employees != null ? String(org.estimated_num_employees) : '',
    industry: org.industry ?? '',
    linkedin_url: p.linkedin_url ?? '',
    city: p.city ?? '',
    state: p.state ?? '',
    country: p.country ?? '',
    seniority: p.seniority ?? '',
    departments: (p.departments ?? []).join('; '),
    apollo_person_id: p.id ?? '',
    apollo_org_id: p.organization_id ?? org.id ?? '',
  };
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvLine = (vals: string[]) => vals.map(csvCell).join(',');

function writeCsv(file: string, rows: Record<string, string>[]): void {
  const lines = [csvLine([...COLUMNS]), ...rows.map((r) => csvLine(COLUMNS.map((c) => r[c] ?? '')))];
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// ---------------- export ----------------

export interface ExportOpts {
  files: number | null; // how many 1,000-row files to enrich this run; null = all remaining
  refresh: boolean; // re-pull the id cache before enriching
  passes?: number; // collection passes (drift mop-up)
}

const partName = (n: number) => `part-${String(n).padStart(2, '0')}.csv`;

/**
 * Enrich not-yet-enriched ids into CSV files of up to 1,000 rows. Spends ~1 credit per lead.
 * Resumable by person-id: ids already present in existing part-*.csv are skipped, so re-running
 * (or re-collecting the id set) never re-charges. New files are numbered after the existing ones.
 */
export async function exportSearch(key: string, opts: ExportOpts): Promise<void> {
  const { name } = resolveSearch(key);
  console.log(`\n=== Apollo export: "${name}" (${key}) ===`);
  console.log('Step 1 — collect ids (free search):');
  const { ids, total_entries } = await collectIds(key, { refresh: opts.refresh, passes: opts.passes });

  const outDir = path.join(OUT_ROOT, key);
  fs.mkdirSync(outDir, { recursive: true });
  const enriched = loadEnrichedIds(key);
  const remaining = ids.filter((id) => !enriched.has(id));
  const coverage = new Set([...ids, ...enriched]).size; // enriched-but-since-dropped ids still count
  const existingFiles = fs.readdirSync(outDir).filter((n) => /^part-\d+\.csv$/.test(n)).length;

  const remainingFiles = Math.ceil(remaining.length / FILE_SIZE);
  const filesThisRun = opts.files == null ? remainingFiles : Math.min(remainingFiles, Math.max(0, opts.files));
  console.log(`\nStep 2 — enrich (COSTS CREDITS):`);
  console.log(`  coverage ${coverage}/${total_entries} · already enriched ${enriched.size} · remaining ${remaining.length} (${remainingFiles} files)`);
  if (remaining.length === 0) { console.log('  nothing to enrich — all collected ids already exported.\n'); return; }
  if (filesThisRun === 0) { console.log('  0 files requested this run (--files 0) — stopping without spending.\n'); return; }
  console.log(`  this run: ${filesThisRun} file(s)${filesThisRun < remainingFiles ? `  (${remainingFiles - filesThisRun} left after)` : ''}, spending up to ~${filesThisRun * FILE_SIZE} credits\n`);

  let creditsTotal = 0;
  for (let k = 0; k < filesThisRun; k++) {
    const slice = remaining.slice(k * FILE_SIZE, (k + 1) * FILE_SIZE);
    const fileNo = existingFiles + k + 1;
    const file = path.join(outDir, partName(fileNo));

    const rows: Record<string, string>[] = [];
    let credits = 0;
    let missing = 0;
    let noEmail = 0;
    for (let i = 0; i < slice.length; i += ENRICH_BATCH) {
      const r = await bulkMatch(slice.slice(i, i + ENRICH_BATCH));
      credits += r.credits_consumed ?? 0;
      for (const m of r.matches) {
        if (!m) { missing++; continue; }
        if (!m.email) noEmail++;
        rows.push(row(m));
      }
      await sleep(150);
    }
    writeCsv(file, rows);
    creditsTotal += credits;
    console.log(
      `  ${partName(fileNo)}: ${rows.length} rows -> ${file}` +
        `  | credits ${credits}${missing ? ` | ${missing} unmatched` : ''}${noEmail ? ` | ${noEmail} without email` : ''}`,
    );
  }

  const leftover = remainingFiles - filesThisRun;
  console.log(`\n=== done: ${filesThisRun} file(s) · ~${creditsTotal} credits spent this run ===`);
  if (leftover > 0) console.log(`Next: npm run cea -- apollo:export ${key} --all   (${leftover} files / ~${remaining.length - filesThisRun * FILE_SIZE} leads left)`);
  else console.log(`All ${coverage} collected leads exported across ${existingFiles + filesThisRun} files in ${outDir}/`);
  console.log();
}

// ---------------- helpers exposed to the CLI ----------------

export async function countSearch(key: string): Promise<void> {
  const { name, filters } = resolveSearch(key);
  const r = await searchPage(filters, 1, 1);
  console.log(`"${name}" (${key}): ${r.total_entries} results`);
}

export function parseUrl(url: string): void {
  const { filters, unmapped } = parseApolloUrl(url);
  console.log('Parsed api_search filters:\n' + JSON.stringify(filters, null, 2));
  const un = Object.keys(unmapped);
  if (un.length) console.log('\n⚠ UNMAPPED params (add to UI_TO_API in searches.ts if they matter):', un);
  else console.log('\nAll params mapped.');
}
