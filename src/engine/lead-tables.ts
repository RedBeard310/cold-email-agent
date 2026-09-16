// The niche lead tables in Postgres: the only tables this repo reads or writes.
// Kept apart from db.ts so niche configs and the CLI can name a table without loading the database driver.

export const LEAD_TABLES = [
  'niche_leads.financial_advisors',
  'niche_leads.financial_advisors_consulti',
  'niche_leads.marketing_agencies',
  'niche_leads.legal',
  'niche_leads.accounting',
  'niche_leads.health_clinics',
  'niche_leads.management_consulting',
  'niche_leads.staffing_recruiting',
] as const;

export type LeadTable = (typeof LEAD_TABLES)[number];

/** A SQL condition with $1, $2... placeholders, plus the values bound to them. */
export interface SqlFilter {
  sql: string;
  params?: unknown[];
}

export function isLeadTable(name: string): name is LeadTable {
  return (LEAD_TABLES as readonly string[]).includes(name);
}

/** Accepts "niche_leads.legal" or plain "legal". Throws with the valid list for anything else. */
export function parseLeadTable(name: string): LeadTable {
  const full = name.includes('.') ? name : `niche_leads.${name}`;
  if (!isLeadTable(full)) throw new Error(`unknown lead table "${name}" (valid: ${LEAD_TABLES.join(', ')})`);
  return full;
}
