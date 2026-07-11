// Cleaned Consulti CSV -> Airtable. Loads approved leads into the SAME base/table as the
// Apollo leads (source column distinguishes them) so verification, dedup, and the SmartLead
// push all work unchanged. Idempotent: upserts merge on email (Consulti rows have no
// apollo_person_id), so re-running never duplicates.
//
// email_status is stamped 'not_checked' so the existing verify:emails sweep (ZeroBounce)
// picks these rows up before any send — Casey wants a re-verification pass first, and that
// command targets rows without an email_verified_date.
import fs from 'node:fs';
import { env } from '../env';
import { parseCsv } from './pull';

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
  if (!res.ok) throw new Error(`Airtable ${method} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function toFields(r: Record<string, string>): Record<string, unknown> {
  const full = r.full_name || `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email || '(unknown)';
  const emp = Number(r.employees);
  const f: Record<string, unknown> = {
    full_name: full,
    first_name: r.first_name || undefined,
    last_name: r.last_name || undefined,
    title: r.title || undefined,
    email: r.email,
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
  if (r.employees && Number.isFinite(emp)) f.employees = emp;
  if (r.segment) f.segment = r.segment; // advisors ruleset: independent | bd_affiliated
  return f;
}

export async function toAirtable(opts: { file: string; baseId: string; table: string; limit?: number }): Promise<void> {
  const rows = parseCsv(fs.readFileSync(opts.file, 'utf8')).filter((r) => r.email);
  const toLoad = opts.limit != null ? rows.slice(0, opts.limit) : rows;
  console.log(`Upserting ${toLoad.length} leads from ${opts.file} into ${opts.baseId}/${opts.table} (merge on email)…`);
  let created = 0;
  let updated = 0;
  for (let i = 0; i < toLoad.length; i += 10) {
    const batch = toLoad.slice(i, i + 10).map((r) => ({ fields: toFields(r) }));
    const r = await req<{ createdRecords?: string[]; updatedRecords?: string[] }>(
      'PATCH',
      `${API}/${opts.baseId}/${encodeURIComponent(opts.table)}`,
      { performUpsert: { fieldsToMergeOn: ['email'] }, records: batch, typecast: true },
    );
    created += r.createdRecords?.length ?? 0;
    updated += r.updatedRecords?.length ?? 0;
    if (i && (i / 10) % 25 === 0) console.log(`  …${i}/${toLoad.length}`);
    await sleep(220); // stay under Airtable's 5 req/s per base
  }
  console.log(`Done: ${created} created, ${updated} updated. https://airtable.com/${opts.baseId}`);
}
