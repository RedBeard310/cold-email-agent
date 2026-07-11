// Generic Airtable lead loader (niche-agnostic). Read-only.
import { env } from '../env';

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

interface Page {
  records: AirtableRecord[];
  offset?: string;
}

/** Fetch all records for a base/table, paginating through Airtable's 100/page limit. */
export async function fetchRecords(
  baseId: string,
  table: string,
  opts: { fields?: string[]; filterByFormula?: string } = {},
): Promise<AirtableRecord[]> {
  const out: AirtableRecord[] = [];
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
  let offset: string | undefined;
  do {
    const p = new URLSearchParams({ pageSize: '100' });
    if (opts.filterByFormula) p.set('filterByFormula', opts.filterByFormula);
    for (const f of opts.fields ?? []) p.append('fields[]', f);
    if (offset) p.set('offset', offset);
    const res = await fetch(`${url}?${p.toString()}`, {
      headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` },
    });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as Page;
    out.push(...page.records);
    offset = page.offset;
    if (offset) await new Promise((r) => setTimeout(r, 220)); // stay under 5 req/s
  } while (offset);
  return out;
}

export interface RecordUpdate {
  id: string;
  fields: Record<string, unknown>;
}

/**
 * PATCH records in place, 10 per request (Airtable's max), throttled under 5 req/s.
 * PATCH only touches the fields provided; other fields are untouched. Returns the count
 * of records written. `onProgress` fires after each batch with the running total.
 */
export async function updateRecords(
  baseId: string,
  table: string,
  updates: RecordUpdate[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
  let done = 0;
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: batch, typecast: false }),
    });
    if (!res.ok) throw new Error(`Airtable PATCH ${res.status}: ${await res.text()}`);
    done += batch.length;
    onProgress?.(done, updates.length);
    if (i + 10 < updates.length) await new Promise((r) => setTimeout(r, 220));
  }
  return done;
}
