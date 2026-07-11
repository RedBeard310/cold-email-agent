// Named Apollo saved-search definitions.
//
// The Apollo API can't reference a saved search by its UI name, only by raw filter params.
// So each saved search a human built in the Apollo UI is captured here as a plain filter
// object (same declarative spirit as the niche configs). Regenerate one from a pasted Apollo
// people-search URL with `parseApolloUrl()` (see `apollo:parse-url` in the CLI).
import type { SearchFilters } from './client';

export interface SavedSearch {
  /** matches the label the human gave it in the Apollo UI (for humans; the API ignores it) */
  name: string;
  filters: SearchFilters;
  /**
   * Optional partition for ID collection. Apollo's relevance-sorted search drifts on deep
   * pagination (pages overlap), so a single >~30-page pull silently misses ~10-15% of matches.
   * Splitting into disjoint shallow segments (each merged over `filters`) and unioning the ids
   * recovers the full set. Each entry overrides the given filter keys. Omit for small searches.
   */
  collectionSegments?: SearchFilters[];
}

/** Cross product of location × employee-range filter overrides (each combo is a disjoint slice). */
function segmentByLocationAndSize(locations: string[], ranges: string[]): SearchFilters[] {
  const out: SearchFilters[] = [];
  for (const loc of locations)
    for (const r of ranges) out.push({ person_locations: [loc], organization_num_employees_ranges: [r] });
  return out;
}

/** UI query-param name -> api_search body field. Extend as new filter types appear. */
const UI_TO_API: Record<string, keyof SearchFilters & string> = {
  'personTitles[]': 'person_titles',
  'personLocations[]': 'person_locations',
  'organizationNumEmployeesRanges[]': 'organization_num_employees_ranges',
  'qOrganizationKeywordTags[]': 'q_organization_keyword_tags',
  'contactEmailStatusV2[]': 'contact_email_status',
};
const IGNORE = new Set(['page', 'sortAscending', 'sortByField', 'recommendationConfigId']);

/** Parse an Apollo `app.apollo.io/#/people?...` URL into api_search filters. */
export function parseApolloUrl(url: string): { filters: SearchFilters; unmapped: Record<string, string[]> } {
  const frag = url.includes('#') ? url.slice(url.indexOf('#') + 1) : url;
  const qs = frag.includes('?') ? frag.slice(frag.indexOf('?') + 1) : frag;
  const params = new URLSearchParams(qs);
  const filters: SearchFilters = {};
  const unmapped: Record<string, string[]> = {};
  for (const [k, v] of params) {
    if (IGNORE.has(k)) continue;
    const api = UI_TO_API[k];
    if (api) ((filters[api] as string[]) ??= []).push(v);
    else (unmapped[k] ??= []).push(v);
  }
  return { filters, unmapped };
}

// ---- captured searches ----

// Source URL (app.apollo.io/#/people?...), pasted 2026-07-01. 11,577 verified results.
// Small marketing agencies (1–20 employees) in US/CA/AU/UK, decision-makers only.
export const marketing_agencies_1: SavedSearch = {
  name: 'Marketing Agencies 1',
  filters: {
    contact_email_status: ['verified'],
    person_titles: ['owner', 'founder', 'chief executive officer', 'managing partner'],
    person_locations: ['United States', 'Canada', 'Australia', 'United Kingdom'],
    organization_num_employees_ranges: ['1,10', '11,20'],
    q_organization_keyword_tags: [
      'digital marketing agency', 'social media marketing agency', 'SMMA', 'SEO agency',
      'search engine optimization agency', 'web design agency', 'web development agency', 'PPC agency',
      'paid search agency', 'Google Ads agency', 'Meta ads agency', 'paid social agency',
      'local marketing agency', 'ecommerce marketing agency', 'content marketing agency', 'branding agency',
      'creative agency', 'PR agency', 'public relations agency', 'email marketing agency',
      'retention marketing agency', 'lead generation agency', 'outbound agency', 'SaaS marketing agency',
      'marketing automation agency', 'HubSpot agency', 'GoHighLevel agency', 'GHL agency', 'Amazon agency',
      'marketplace agency', 'influencer agency', 'UGC agency', 'growth marketing agency', 'fractional CMO',
      'marketing consultancy', 'real estate marketing agency', 'dental marketing agency',
      'medical marketing agency', 'law firm marketing agency', 'home services marketing agency',
    ],
  },
  // 4 countries × 6 fine employee bands = 24 disjoint slices, each shallow enough to page without
  // drift (the big US/UK 1–5 bands were still ~20-40 pages deep and leaked ~80 leads at coarser
  // banding). Bands partition 1–20 with no gaps/overlaps; their counts sum to the unfiltered total.
  collectionSegments: segmentByLocationAndSize(
    ['United States', 'Canada', 'Australia', 'United Kingdom'],
    ['1,2', '3,4', '5,6', '7,10', '11,15', '16,20'],
  ),
};

export const SEARCHES: Record<string, SavedSearch> = {
  marketing_agencies_1,
};
