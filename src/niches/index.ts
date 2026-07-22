// Niche registry — campaign commands resolve their config here via the --niche flag.
// Adding a niche = add its config module and one line below (SPEC.md §3).

import type { NicheConfig } from '../engine/types';
import { financialAdvisors } from './financial_advisors/config';
import { marketingAgencies } from './marketing_agencies/config';

export const NICHES: Record<string, NicheConfig> = {
  [financialAdvisors.niche]: financialAdvisors,
  [marketingAgencies.niche]: marketingAgencies,
};
