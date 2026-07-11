// Apollo.io API client — read (search) + enrich (bulk match).
//
// Two-step reality of the current Apollo API (mid-2026):
//   1. `mixed_people/api_search` is FREE but returns OBFUSCATED people (masked last name,
//      `has_email: true` boolean instead of the address). Use it only to collect person ids.
//   2. `people/bulk_match` ENRICHES up to 10 ids per call, returns the real email + full
//      profile, and CONSUMES ~1 credit per revealed record.
// The old `mixed_people/search` endpoint is deprecated for API callers and 422s.
import { env } from '../env';

const BASE = 'https://api.apollo.io/api/v1';

function key(): string {
  const k = env.APOLLO_API_KEY;
  if (!k) throw new Error('APOLLO_API_KEY missing from env-storage/.env (needed for apollo:* commands)');
  return k;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST with retry. Apollo rate-limits per minute/hour/day; on 429 it may send Retry-After.
 * 5xx are transient. Everything else throws immediately with the response body.
 */
async function req<T>(path: string, body: unknown, attempt = 0): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`Apollo ${path} -> ${res.status} after ${attempt} retries: ${text.slice(0, 300)}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 2000 * 2 ** attempt);
    await sleep(wait);
    return req<T>(path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`Apollo ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// ---------------- search (free, obfuscated) ----------------

/** Apollo People Search filters (api_search body). All arrays; omit to leave unfiltered. */
export interface SearchFilters {
  person_titles?: string[];
  person_locations?: string[];
  organization_num_employees_ranges?: string[]; // e.g. "1,10"
  q_organization_keyword_tags?: string[];
  contact_email_status?: string[]; // e.g. "verified"
  [k: string]: unknown;
}

export interface SearchPerson {
  id: string;
  first_name?: string;
  last_name_obfuscated?: string;
  title?: string;
  has_email?: boolean;
  organization?: { name?: string };
}

export interface SearchPage {
  total_entries: number;
  people: SearchPerson[];
}

/** Apollo caps `page * per_page` at 50,000. per_page max is 100. */
export const MAX_SEARCH_DEPTH = 50_000;
export const SEARCH_PAGE_SIZE = 100;

export function searchPage(filters: SearchFilters, page: number, perPage = SEARCH_PAGE_SIZE): Promise<SearchPage> {
  return req<SearchPage>('/mixed_people/api_search', { ...filters, page, per_page: perPage });
}

// ---------------- enrich (costs credits, real data) ----------------

export interface EnrichedPerson {
  id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  headline?: string;
  email?: string;
  email_status?: string;
  linkedin_url?: string;
  seniority?: string;
  departments?: string[];
  city?: string;
  state?: string;
  country?: string;
  organization_id?: string;
  organization?: {
    id?: string;
    name?: string;
    primary_domain?: string;
    website_url?: string;
    estimated_num_employees?: number;
    industry?: string;
    phone?: string;
  };
}

export interface BulkMatchResult {
  matches: (EnrichedPerson | null)[];
  total_requested_enrichments?: number;
  unique_enriched_records?: number;
  missing_records?: number;
  credits_consumed?: number;
}

/** Enrich up to 10 people by Apollo id. reveal_personal_emails stays false (work emails only). */
export function bulkMatch(ids: string[]): Promise<BulkMatchResult> {
  if (ids.length > 10) throw new Error(`bulkMatch takes at most 10 ids, got ${ids.length}`);
  return req<BulkMatchResult>('/people/bulk_match', {
    reveal_personal_emails: false,
    reveal_phone_number: false,
    details: ids.map((id) => ({ id })),
  });
}
