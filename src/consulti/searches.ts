// Named Consulti search specs — the pull layer is generic, each pull target is a config
// (same pattern as niche configs: engine knows nothing about verticals).
//
// Slices are walked in declared order until --count is reached, so order = spend priority.
// Slice keys must be unique ACROSS specs: they key the shared cursor state in
// .consulti/state.json (marketing's pr/design/marketing cursors predate this file).
import type { SearchFilters } from './client';

export interface SliceDef {
  key: string;
  filters: SearchFilters;
}

export interface SearchSpec {
  key: string;
  /** Stamped into the CSV search_name column (with the slice key appended). */
  name: string;
  /** Raw CSV filename prefix in .consulti/ — also scopes cross-tranche email dedupe. */
  rawPrefix: string;
  slices: SliceDef[];
}

/** Owner-signal titles (validated 2026-07-10: kills all mid-level noise vs the long list). */
const OWNER_TITLES = [
  'Owner', 'Founder', 'Co-Founder', 'CEO', 'Chief Executive', 'President',
  'Principal', 'Managing Partner', 'Managing Director', 'Partner',
];

/** Shared base for the industry-sliced SMB-owner niches (marketing, legal, accounting, …). */
const SMB_OWNER_BASE: Omit<SearchFilters, 'industries'> = {
  countries: ['United States', 'Canada'],
  titles: OWNER_TITLES,
  empMin: 1,
  empMax: 20,
};

/** Independent-RIA proxy filters (validated by 75-row sampling, 2026-07-10):
 *  1-20 employees kills wirehouses/banks/insurance BDs at the company level; the advisors
 *  clean ruleset catches the leaks (nm.com branch teams, "| RJFS" titles, 401k plan shops).
 *  Banking / Insurance / Capital Markets industries are deliberately absent — those are the
 *  compliance-handcuffed segments this niche must never target. */
const ADVISOR_BASE: Omit<SearchFilters, 'titles'> = {
  industries: ['Financial Services', 'Investment Management'],
  countries: ['United States'],
  empMin: 1,
  empMax: 20,
};

export const SEARCHES: SearchSpec[] = [
  {
    key: 'marketing',
    name: 'Marketing + PR + Graphic Design | Jul 10 2026',
    rawPrefix: 'raw-',
    slices: [
      // Measured-quality order (PR & Comms ≈95% fit, Graphic Design ≈95%, Marketing ≈72-75%).
      { key: 'pr', filters: { ...SMB_OWNER_BASE, industries: ['Public Relations & Communications'] } },
      { key: 'design', filters: { ...SMB_OWNER_BASE, industries: ['Graphic Design'] } },
      { key: 'marketing', filters: { ...SMB_OWNER_BASE, industries: ['Marketing & Advertising'] } },
    ],
  },
  {
    key: 'legal',
    name: 'Law + Legal Services | Jul 10 2026',
    rawPrefix: 'raw-legal-',
    slices: [
      // ~87% sampled fit (13/15, homepage-verified, 2026-07-10). Law Practice first —
      // "Legal Services" also carries court reporters / process servers / transcription
      // vendors (per-niche blocklist should add those terms before a big pull).
      { key: 'law_practice', filters: { ...SMB_OWNER_BASE, industries: ['Law Practice'] } },
      { key: 'legal_services', filters: { ...SMB_OWNER_BASE, industries: ['Legal Services'] } },
    ],
  },
  {
    key: 'accounting',
    name: 'Accounting | Jul 10 2026',
    rawPrefix: 'raw-accounting-',
    slices: [
      // ~90% sampled fit — cleanest niche tested. Noise: business-lending/factoring cos.
      { key: 'accounting', filters: { ...SMB_OWNER_BASE, industries: ['Accounting'] } },
    ],
  },
  {
    key: 'health_clinics',
    name: 'Medical + Alt Med + Mental Health | Jul 10 2026',
    rawPrefix: 'raw-health-',
    slices: [
      // ~80% sampled fit. Deliberately EXCLUDES "Health, Wellness & Fitness" — including it
      // dropped fit to ~50% (gyms, massage, supplements, equipment retail).
      { key: 'medical', filters: { ...SMB_OWNER_BASE, industries: ['Medical Practice'] } },
      { key: 'mental_health', filters: { ...SMB_OWNER_BASE, industries: ['Mental Health Care'] } },
      { key: 'alt_med', filters: { ...SMB_OWNER_BASE, industries: ['Alternative Medicine'] } },
    ],
  },
  {
    key: 'management_consulting',
    name: 'Management Consulting | Jul 10 2026',
    rawPrefix: 'raw-consulting-',
    slices: [
      // ~82% sampled fit (≈85-90% post-clean: VP-title and print-co noise is caught
      // client-side). Copy caveat: specialist consultancies, NOT biz-opp coaches —
      // sales training / business-growth coaching flopped in the orchestrator reply data.
      { key: 'consulting', filters: { ...SMB_OWNER_BASE, industries: ['Management Consulting'] } },
    ],
  },
  {
    key: 'staffing',
    name: 'Staffing & Recruiting | Jul 11 2026',
    rawPrefix: 'raw-staffing-',
    slices: [
      // ~93% sampled fit (13/14 unique, homepage-verified, 2026-07-11) — boutique exec-search/
      // personnel firms, cleanest sample since accounting. Pool >10k (capped). The separate
      // "Human Resources" industry (probed 4,306) is deliberately NOT included — untested fit.
      { key: 'staffing', filters: { ...SMB_OWNER_BASE, industries: ['Staffing & Recruiting'] } },
    ],
  },
  {
    key: 'advisors',
    name: 'Independent Financial Advisors + Retirement | Jul 10 2026',
    rawPrefix: 'raw-advisors-',
    slices: [
      // ret first: smallest pool (393) and Casey explicitly wants retirement income planners —
      // a count-limited tranche must not starve it behind the 5k advisor slice.
      { key: 'ret', filters: { ...ADVISOR_BASE, titles: ['Retirement'] } },
      { key: 'wealth', filters: { ...ADVISOR_BASE, titles: ['Wealth Advisor', 'Wealth Manager'] } },
      { key: 'fa', filters: { ...ADVISOR_BASE, titles: ['Financial Advisor'] } },
      { key: 'planner', filters: { ...ADVISOR_BASE, titles: ['Financial Planner'] } },
    ],
  },
  {
    // Phase 2a (Casey, 2026-07-10): mid-size independent RIAs — still self-regulated (own ADV,
    // own compliance, no BD veto), just bigger firms. Advisors at $1-10B RIAs are among the
    // most active YouTube creators in the industry. Single slice with all title keywords OR'd
    // so overlapping titles can't bill cross-slice duplicates (the emp 1-20 pull wasted 1,702
    // credits that way). Pool probed at ~3,943.
    key: 'advisors_midsize',
    name: 'Mid-size Independent RIAs (21-100 emp) | Jul 10 2026',
    rawPrefix: 'raw-advisors-midsize-',
    slices: [
      {
        key: 'midsize',
        filters: {
          industries: ['Financial Services', 'Investment Management'],
          countries: ['United States'],
          titles: ['Financial Advisor', 'Financial Planner', 'Wealth Advisor', 'Wealth Manager', 'Retirement'],
          empMin: 21,
          empMax: 100,
        },
      },
    ],
  },
  {
    // Phase 2b (Casey, 2026-07-10): advisors listed directly under the BD brands with documented
    // advisor-content cultures. Thin by design — most affiliated advisors appear under practice
    // DBAs (caught instead by the bd_affiliated email-domain/title tagging). No emp cap: parent
    // brands are giant. Commonwealth probed 0, omitted. The advisors clean ruleset tags these
    // bd_affiliated (and still captive-rejects "Raymond James & Associates" employee-channel rows).
    key: 'advisors_lenient_bd',
    name: 'Lenient-BD Brand-Listed Advisors | Jul 10 2026',
    rawPrefix: 'raw-advisors-lenientbd-',
    slices: [
      { key: 'bd_rj', filters: { company: 'Raymond James', countries: ['United States'], titles: ['Financial Advisor', 'Financial Planner', 'Wealth Advisor', 'Wealth Manager', 'Retirement'] } },
      { key: 'bd_lpl', filters: { company: 'LPL Financial', countries: ['United States'], titles: ['Financial Advisor', 'Financial Planner', 'Wealth Advisor', 'Wealth Manager', 'Retirement'] } },
      { key: 'bd_cambridge', filters: { company: 'Cambridge Investment Research', countries: ['United States'], titles: ['Financial Advisor', 'Financial Planner', 'Wealth Advisor', 'Wealth Manager', 'Retirement'] } },
    ],
  },
];

export function getSearch(key: string): SearchSpec {
  const s = SEARCHES.find((x) => x.key === key);
  if (!s) throw new Error(`unknown search "${key}" (valid: ${SEARCHES.map((x) => x.key).join(', ')})`);
  return s;
}
