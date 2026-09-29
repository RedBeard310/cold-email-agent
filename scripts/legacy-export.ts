// Shared reader for the final the old database export (2026-09-13). Local files only; nothing here calls the old database.
//
// Layout: <dir>/<base_id>/_schema.json is the base's Meta API schema, and <dir>/<base_id>/<table_id>.json
// is {base_id, table_id, table_name, exported_at, records: [{id, createdTime, fields}]}, with empty
// fields left out. The 5 deep-research bases sit under <dir>/research-bases/. Summary and log files
// are ignored.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const EXPORT_DIR = process.argv[2] ?? '/home/casey/.claude/legacy-final-export-2026-09-13';

/** The export files carry base ids only, so the names live here. */
export const BASE_NAMES: Record<string, string> = {
  app2QEhEjXdBPjOpM: 'CGC - D100 Generation',
  appvEVgfYvyNIms2h: 'Financial Advisor Leads',
  appGzk9z2io4dPJUB: 'Marketing Agency Leads',
  app8n1wbsUWA2gz2d: 'Legal Leads',
  app2hlEL7sBTl5wcK: 'Accounting Leads',
  appxifYj6Do6jfYGR: 'Health Clinic Leads',
  app5OHPgae9dTLSCD: 'Management Consulting Leads',
  appi362RoZ7vi2Hsd: 'Staffing & Recruiting Leads',
  appenY7r5jlZMRpJ0: 'Scraped YouTube Leads',
  appWBxaqgDcwX4nz4: 'Conor Jonasson — Channel Research',
  appVlri6gCVfRgwhe: 'Lane Martinsen — Channel Research',
  appAw3occNrWKPx2s: 'Eric Nowoslawski — Channel Research',
  app3Si7q3HPbhjt2f: 'Nick Saraev — Channel Research',
  appwSwSe8Slw7qAUS: 'Santiago Acevedo — Channel Research',
};

export interface the old databaseField { id: string; name: string; type: string; options?: Record<string, unknown> }
export interface the old databaseTable { id: string; name: string; primaryFieldId: string; fields: the old databaseField[] }
export interface ExportRecord { id: string; createdTime?: string; fields: Record<string, unknown> }
export interface ExportFile {
  base_id: string;
  table_id: string;
  table_name: string;
  exported_at: string;
  records: ExportRecord[];
}
export interface ExportedTable { baseId: string; baseName: string; schema: the old databaseTable; path: string }

export function readJson<T>(path: string | URL): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function baseDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('app'))
    .map((d) => join(dir, d.name))
    .sort();
}

/** Every exported table, in a stable order, matched to its entry in _schema.json. */
export function exportedTables(): ExportedTable[] {
  const out: ExportedTable[] = [];
  for (const dir of [...baseDirs(EXPORT_DIR), ...baseDirs(join(EXPORT_DIR, 'research-bases'))]) {
    const baseId = basename(dir);
    const baseName = BASE_NAMES[baseId];
    if (!baseName) throw new Error(`No base name for ${baseId}. Add it to BASE_NAMES.`);
    const { tables } = readJson<{ tables: the old databaseTable[] }>(join(dir, '_schema.json'));
    for (const file of readdirSync(dir).filter((f) => /^tbl[A-Za-z0-9]+\.json$/.test(f)).sort()) {
      const schema = tables.find((t) => `${t.id}.json` === file);
      if (!schema) throw new Error(`${baseId}/${file} has no entry in _schema.json`);
      out.push({ baseId, baseName, schema, path: join(dir, file) });
    }
  }
  return out;
}

export function readExport(t: ExportedTable): ExportFile {
  const file = readJson<ExportFile>(t.path);
  if (file.base_id !== t.baseId || file.table_id !== t.schema.id) {
    throw new Error(`${t.path}: the ids inside the file don't match its location`);
  }
  return file;
}

/** the old database leaves empty fields out. Missing, null, empty string, and empty list all count as blank. */
export function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

// ---- The column map written by scripts/gen-niche-leads-ddl.ts ----

export type Kind = 'text' | 'text_array' | 'integer' | 'float' | 'boolean' | 'date' | 'timestamptz' | 'json_text';

export interface NicheColumn {
  field: string;
  column: string;
  source_type: string;
  pg_type: string;
  kind: Kind;
  note?: string;
}

export interface NicheTable {
  table: string;
  base_id: string;
  base_name: string;
  table_id: string;
  table_name: string;
  records: number;
  columns: NicheColumn[];
  dropped: { field: string; source_type: string; reason: string }[];
  unique_keys: { column: string; indexed: boolean; duplicate_rows: number }[];
}

export const COLUMN_MAP_PATH = new URL('../migrations/niche-leads-columns.json', import.meta.url);

export function nicheTables(): NicheTable[] {
  return readJson<{ tables: NicheTable[] }>(COLUMN_MAP_PATH).tables;
}
