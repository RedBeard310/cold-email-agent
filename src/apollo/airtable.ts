// Apollo export -> Airtable ingestion. Creates (or reuses) a per-niche leads base/table and
// upserts the enriched CSV rows into it. Idempotent: upserts merge on apollo_person_id, so
// re-running never duplicates and safely tops up after a later enrichment pass.
//
// This is the marketing-agencies niche's stand-in for an upstream lead-finder repo: the Apollo
// export IS the lead source, so ingestion lives here rather than in a separate producer.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { env } from '../env';

const META = 'https://api.airtable.com/v0/meta';
const API = 'https://api.airtable.com/v0';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req<T>(method: string, url: string, body?: unknown, attempt = 0): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`Airtable ${method} ${url} -> ${res.status} after ${attempt} retries`);
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    return req<T>(method, url, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Airtable ${method} ${url.replace(API, '').replace(META, '')} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// ---------------- table schema (mirrors the finance base's lead spine, agency-flavoured) ----------------

/** First field becomes the primary field — must be a primary-eligible type (singleLineText is safe). */
export const LEAD_FIELDS = [
  { name: 'full_name', type: 'singleLineText' },
  { name: 'first_name', type: 'singleLineText' },
  { name: 'last_name', type: 'singleLineText' },
  { name: 'title', type: 'singleLineText' },
  { name: 'email', type: 'email' },
  { name: 'email_status', type: 'singleSelect', options: { choices: [{ name: 'verified' }, { name: 'extrapolated' }, { name: 'unavailable' }, { name: 'unverified' }] } },
  { name: 'company', type: 'singleLineText' },
  { name: 'domain', type: 'singleLineText' },
  { name: 'website', type: 'url' },
  { name: 'employees', type: 'number', options: { precision: 0 } },
  { name: 'industry', type: 'singleLineText' },
  { name: 'linkedin_url', type: 'url' },
  { name: 'city', type: 'singleLineText' },
  { name: 'state', type: 'singleLineText' },
  { name: 'country', type: 'singleLineText' },
  { name: 'seniority', type: 'singleLineText' },
  { name: 'departments', type: 'singleLineText' },
  { name: 'apollo_person_id', type: 'singleLineText' },
  { name: 'apollo_org_id', type: 'singleLineText' },
  { name: 'source', type: 'singleLineText' },
  { name: 'search_name', type: 'singleLineText' },
] as const;

const MERGE_ON = 'apollo_person_id';

// ---------------- schema ops ----------------

interface TableInfo { id: string; name: string }
interface BaseCreated { id: string; tables: TableInfo[] }

export async function createBaseWithTable(workspaceId: string, baseName: string, tableName: string): Promise<{ baseId: string; tableId: string }> {
  const r = await req<BaseCreated>('POST', `${META}/bases`, {
    name: baseName,
    workspaceId,
    tables: [{ name: tableName, fields: LEAD_FIELDS }],
  });
  const tableId = r.tables[0]?.id;
  if (!tableId) throw new Error(`base created but no table id returned: ${JSON.stringify(r)}`);
  return { baseId: r.id, tableId };
}

export async function ensureTable(baseId: string, tableName: string): Promise<string> {
  const { tables } = await req<{ tables: TableInfo[] }>('GET', `${META}/bases/${baseId}/tables`);
  const existing = tables.find((t) => t.name === tableName);
  if (existing) return existing.id;
  const created = await req<TableInfo>('POST', `${META}/bases/${baseId}/tables`, { name: tableName, fields: LEAD_FIELDS });
  return created.id;
}

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
  const full = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email || r.company || '(unknown)';
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
  if (r.email) f.email = r.email;
  if (r.email_status) f.email_status = r.email_status;
  if (r.website) f.website = `https://${r.website}`;
  if (r.employees && Number.isFinite(emp)) f.employees = emp;
  return f;
}

// ---------------- orchestration ----------------

export interface IngestOpts {
  workspaceId?: string; // create a new dedicated base here
  baseId?: string; // OR add a table to this existing base
  table: string;
  baseName: string;
  searchName: string;
  limit?: number; // only upsert the first N records (sample a new base before loading all)
}

export async function ingest(key: string, opts: IngestOpts): Promise<void> {
  console.log(`\n=== Apollo -> Airtable: "${key}" ===`);
  const rows = readAllRows(key);
  // dedupe by person id (keep first); people with no id fall back to email
  const seen = new Set<string>();
  const records: { fields: Record<string, unknown> }[] = [];
  let noEmail = 0;
  let dupes = 0;
  for (const r of rows) {
    const dedup = r.apollo_person_id || r.email;
    if (dedup && seen.has(dedup)) { dupes++; continue; }
    if (dedup) seen.add(dedup);
    if (!r.email) noEmail++;
    records.push({ fields: toFields(r, opts.searchName) });
  }
  console.log(`  read ${rows.length} rows -> ${records.length} unique (${dupes} dup person-ids skipped, ${noEmail} without email)`);
  const toLoad = opts.limit != null ? records.slice(0, opts.limit) : records;
  if (opts.limit != null) console.log(`  --limit ${opts.limit}: loading only the first ${toLoad.length} this run`);

  // Prefer an explicit base; else create in the given workspace (falling back to env-storage's
  // AIRTABLE_WORKSPACE_ID so `apollo:to-airtable` needs no flags once that's set).
  const workspaceId = opts.baseId ? undefined : opts.workspaceId ?? env.AIRTABLE_WORKSPACE_ID;
  let baseId = opts.baseId ?? '';
  let tableId = '';
  if (baseId) {
    tableId = await ensureTable(baseId, opts.table);
    console.log(`  using base ${baseId}, table "${opts.table}" (${tableId})`);
  } else if (workspaceId) {
    console.log(`  creating base "${opts.baseName}" (table "${opts.table}") in workspace ${workspaceId}…`);
    ({ baseId, tableId } = await createBaseWithTable(workspaceId, opts.baseName, opts.table));
    console.log(`  created base ${baseId}, table ${tableId}`);
  } else {
    throw new Error('no destination: set AIRTABLE_WORKSPACE_ID in env-storage, or pass --workspace <wspId> / --base <appId>');
  }

  console.log(`  upserting ${toLoad.length} records (merge on ${MERGE_ON})…`);
  let created = 0;
  let updated = 0;
  for (let i = 0; i < toLoad.length; i += 10) {
    const batch = toLoad.slice(i, i + 10);
    const r = await req<{ createdRecords?: string[]; updatedRecords?: string[] }>(
      'PATCH',
      `${API}/${baseId}/${tableId}`,
      { performUpsert: { fieldsToMergeOn: [MERGE_ON] }, records: batch, typecast: true },
    );
    created += r.createdRecords?.length ?? 0;
    updated += r.updatedRecords?.length ?? 0;
    if ((i / 10) % 25 === 0 && i) console.log(`    …${i}/${toLoad.length}`);
    await sleep(220); // stay under Airtable's 5 req/s per base
  }
  console.log(`\n=== done: ${created} created, ${updated} updated in base ${baseId} ===`);
  console.log(`  https://airtable.com/${baseId}\n`);
}
