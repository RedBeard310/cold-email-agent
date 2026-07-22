// marketing_agencies niche config. All vertical-specific wiring lives here (SPEC.md §3).
//
// A/B test: two sequences (Hillsberg vs Lucero copy) -> two campaigns, 50/50 equalSplit,
// identical schedule/settings/inbox pool — copy is the only variable.

import type { NicheConfig } from '../../engine/types';
import { sequences } from './copy';

export const marketingAgencies: NicheConfig = {
  niche: 'marketing_agencies',
  airtable: {
    baseId: 'appGzk9z2io4dPJUB',
    table: 'Leads',
    // Verified-deliverable only (10,133 of 10,833 rows as of 2026-07-22).
    // catch-all/risky/unknown stay out until re-verified.
    segmentFormula: "{email_status}='valid'",
  },
  fieldMap: {
    // SmartLead field -> Airtable source.
    email: { from: 'email' },
    // No titleCase transform on purpose: this base's first_name is clean-cased and never
    // blank (checked 2026-07-22), and the transform would mangle names like "DeAngelo".
    first_name: { from: 'first_name', fallback: 'there' },
  },
  campaignPrefix: 'Marketing Agency: ',
  sequences,
};
