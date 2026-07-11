// Consulti.ai API client — B2B lead search + credit balance.
//
// Billing reality (docs/consulti-api.md): /leads/search bills 1 lead credit PER RETURNED ROW
// (reserved up to `size`, refunded down to actual rows; 0 rows = 0 credits). There is no free
// preview — every fetched lead is paid for, so the pull layer must never fetch rows it will
// knowingly discard for reasons it could have filtered server-side.
//
// Search gotchas learned by sampling (2026-07-10, see memory + docs):
//   - Results are ordered alphabetically by first name; page 1 is not a representative sample.
//   - `total` in the response caps at 10,001 (search-engine style); pagination works past it.
//   - The `titles` filter is loose keyword matching ("President" matches "Vice President") —
//     the clean pass drops the leaks client-side.
import { env } from '../env';

const BASE = 'https://www.consulti.ai/api/v1';

function key(): string {
  const k = env.CONSULTI_API_KEY;
  if (!k) throw new Error('CONSULTI_API_KEY missing from env-storage/.env (needed for consulti:* commands)');
  return k;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req<T>(path: string, body?: unknown, attempt = 0): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key()}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`Consulti ${path} -> ${res.status} after ${attempt} retries: ${text.slice(0, 300)}`);
    await sleep(Math.min(60_000, 2000 * 2 ** attempt));
    return req<T>(path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`Consulti ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export interface ConsultiLead {
  first_name: string | null;
  last_name: string | null;
  email: string;
  job_title: string | null;
  company_name: string | null;
  company_domain: string | null;
  linkedin_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  employees: number | null;
  industry: string | null;
  technologies: string[] | null;
  mobile_phone: string | null;
  company_phone: string | null;
  email_status: string | null;
}

export interface SearchFilters {
  industries?: string[];
  countries?: string[];
  titles?: string[];
  /** Company-name match. NOTE: thin for BD networks — Consulti lists most affiliated advisors
   *  under their practice DBA, not the parent brand (probed 2026-07-10: LPL 10, RJ 217). */
  company?: string;
  empMin?: number;
  empMax?: number;
  q?: string;
}

/** One page of /leads/search. Bills 1 lead credit per returned row. */
export async function searchLeads(
  filters: SearchFilters,
  page: number,
  size: number,
): Promise<{ leads: ConsultiLead[]; total: number }> {
  const r = await req<{ leads?: ConsultiLead[]; total?: number }>('/leads/search', { ...filters, page, size });
  return { leads: r.leads ?? [], total: r.total ?? 0 };
}

export async function getCredits(): Promise<{ lead_credits: number; verification_credits: number }> {
  const r = await req<{ data: { lead_credits: number; verification_credits: number } }>('/credits');
  return r.data;
}

// ---------------- saved lead lists (all free) ----------------

export interface ConsultiList { id: string; name: string; member_count: number }

export async function getLists(): Promise<ConsultiList[]> {
  const r = await req<{ lists: ConsultiList[] }>('/lists');
  return r.lists;
}

export async function createList(name: string, description?: string): Promise<string> {
  const r = await req<{ list: { id: string } }>('/lists', { name, description });
  return r.list.id;
}

/** Add leads by email. Free; duplicates are ignored server-side. */
export async function addLeadsToList(id: string, emails: string[]): Promise<{ added: number; skipped: number }> {
  return req<{ added: number; skipped: number }>(`/lists/${id}/add-leads`, { emails });
}
