// Apply a niche field map to one Airtable record -> a SmartLead lead object.
import type { NicheConfig } from './types';

export function mapLead(
  fields: Record<string, unknown>,
  fieldMap: NicheConfig['fieldMap'],
): Record<string, string> {
  const lead: Record<string, string> = {};
  for (const [target, entry] of Object.entries(fieldMap)) {
    const raw = fields[entry.from];
    let val = entry.transform ? entry.transform(raw) : raw == null ? null : String(raw).trim();
    if (val == null || val === '') val = entry.fallback ?? '';
    lead[target] = val;
  }
  return lead;
}
