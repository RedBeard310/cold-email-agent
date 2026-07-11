// financial_advisors niche config (SPEC.md §4). All vertical-specific wiring lives here.

import type { NicheConfig } from '../../engine/types';
import { titleCaseName } from '../../engine/normalize';
import { sequences } from './copy';

/** Airtable formula selecting the active first-wave segment: the retirement_income tag. */
export const RETIREMENT_INCOME = 'FIND("retirement_income", ARRAYJOIN({tags}))';

export const financialAdvisors: NicheConfig = {
  niche: 'financial_advisors',
  airtable: {
    baseId: 'appvEVgfYvyNIms2h',
    table: 'Table 1',
    // Full base (~4,565). RETIREMENT_INCOME was the initial 1,577-lead beachhead wave;
    // Casey expanded to the whole list on 2026-06-18. Set segmentFormula back to
    // RETIREMENT_INCOME (or any tag formula) to re-scope a future wave.
    segmentFormula: undefined,
  },
  fieldMap: {
    // SmartLead field -> Airtable source.
    email: { from: 'email' },
    first_name: { from: 'owner_first_name', transform: titleCaseName, fallback: 'there' },
  },
  campaignPrefix: 'Financial Advisor: ',
  sequences,
};
