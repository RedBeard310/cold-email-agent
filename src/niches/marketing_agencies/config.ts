// marketing_agencies niche config. All vertical-specific wiring lives here (SPEC.md §3).
//
// A/B test: two sequences (Hillsberg vs Lucero copy) -> two campaigns, 50/50 equalSplit,
// identical schedule/settings/inbox pool — copy is the only variable.

import type { NicheConfig } from '../../engine/types';
import { sequences } from './copy';

export const marketingAgencies: NicheConfig = {
  niche: 'marketing_agencies',
  leads: {
    table: 'niche_leads.marketing_agencies',
    // Verified-deliverable only (10,133 of 10,833 rows as of 2026-07-22).
    // catch-all/risky/unknown stay out until re-verified.
    segment: { sql: 'email_status = $1', params: ['valid'] },
  },
  fieldMap: {
    // SmartLead field -> column in niche_leads.marketing_agencies.
    email: { from: 'email' },
    // No titleCase transform on purpose: this table's first_name is clean-cased and never
    // blank (checked 2026-07-22), and the transform would mangle names like "DeAngelo".
    first_name: { from: 'first_name', fallback: 'there' },
  },
  campaignPrefix: 'Marketing Agency: ',
  sequences,
};
