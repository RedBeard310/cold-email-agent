// financial_advisors niche config (SPEC.md §4). All vertical-specific wiring lives here.

import type { SqlFilter } from '../../engine/lead-tables';
import type { NicheConfig } from '../../engine/types';
import { titleCaseName } from '../../engine/normalize';
import { sequences } from './copy';

/** Segment selecting the first-wave beachhead: leads tagged retirement_income. */
export const RETIREMENT_INCOME: SqlFilter = { sql: '$1 = ANY(tags)', params: ['retirement_income'] };

export const financialAdvisors: NicheConfig = {
  niche: 'financial_advisors',
  leads: {
    table: 'niche_leads.financial_advisors',
    // Full table (~4,565). RETIREMENT_INCOME was the initial 1,577-lead beachhead wave;
    // Casey expanded to the whole list on 2026-06-18. Set segment back to
    // RETIREMENT_INCOME (or any tag condition) to re-scope a future wave.
    segment: undefined,
  },
  fieldMap: {
    // SmartLead field -> column in niche_leads.financial_advisors.
    email: { from: 'email' },
    first_name: { from: 'owner_first_name', transform: titleCaseName, fallback: 'there' },
  },
  campaignPrefix: 'Financial Advisor: ',
  sequences,
};
