// Loads the final the old database export (2026-09-13) into Postgres. Reads local files only; nothing here
// calls the old database.
//   - Every exported table goes into archive.legacy_export_tables and archive.legacy_export_records, as is.
//   - The 8 cold-email lead tables also go into their typed niche_leads tables, converted with the
//     column map in migrations/niche-leads-columns.json.
// One transaction per table. Every insert is ON CONFLICT (primary key) DO NOTHING, so a rerun skips
// the rows it already loaded, while a clash on any other unique index (such as email, from 0002)
// stops the load instead of dropping the row quietly.
// Apply migrations/0000_archive.sql and migrations/0001_niche_leads.sql first. 0002 can come before
// or after the load.
//
//   npx tsx scripts/load-legacy-export.ts [export_dir]
import { closePool, getPool } from 'pipeline-db';
import { exportedTables, isBlank, nicheTables, readExport, type Kind } from './legacy-export';

/** The part of a pg client this script uses. */
interface Client { query(text: string, params?: unknown[]): Promise<{ rowCount: number | null }> }
type Column = [name: string, pgType: string];

const ARCHIVE_COLUMNS: Column[] = [
  ['base_id', 'text'], ['base_name', 'text'], ['table_id', 'text'], ['table_name', 'text'],
  ['record_id', 'text'], ['created_time', 'timestamptz'], ['fields', 'jsonb'], ['exported_at', 'timestamptz'],
];

const MISFIT = Symbol('misfit');

function isIsoDate(s: string): boolean {
  const ms = Date.parse(`${s}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(s);
}

/** Convert one exported value for its typed column. Blank becomes NULL, or false for a checkbox. */
function convert(kind: Kind, v: unknown): unknown {
  if (isBlank(v)) return kind === 'boolean' ? false : null;
  switch (kind) {
    case 'text': return typeof v === 'string' ? v : MISFIT;
    case 'text_array': return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : MISFIT;
    case 'integer': return Number.isSafeInteger(v) ? v : MISFIT;
    case 'float': return typeof v === 'number' && Number.isFinite(v) ? v : MISFIT;
    case 'boolean': return typeof v === 'boolean' ? v : MISFIT;
    case 'date': return typeof v === 'string' && isIsoDate(v) ? v : MISFIT;
    case 'timestamptz':
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)) ? v : MISFIT;
    case 'json_text': return typeof v === 'string' ? v : JSON.stringify(v);
  }
}

/** Multi-row parameterized INSERT ... ON CONFLICT (key) DO NOTHING, where key is the table's primary
 *  key columns. Returns the rows actually inserted. */
async function insertRows(client: Client, table: string, key: string, columns: Column[], rows: unknown[][]): Promise<number> {
  const perBatch = Math.min(500, Math.floor(30_000 / columns.length));
  const names = columns.map(([name]) => `"${name}"`).join(', ');
  let inserted = 0;
  for (let i = 0; i < rows.length; i += perBatch) {
    const params: unknown[] = [];
    const tuples = rows.slice(i, i + perBatch).map((row) => {
      const slots = row.map((value, j) => {
        params.push(value);
        return `$${params.length}::${columns[j]![1]}`;
      });
      return `(${slots.join(', ')})`;
    });
    const res = await client.query(
      `INSERT INTO ${table} (${names}) VALUES ${tuples.join(', ')} ON CONFLICT (${key}) DO NOTHING`,
      params,
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

async function main(): Promise<void> {
  const niche = nicheTables();
  const issues = new Map<string, { count: number; ids: string[] }>();
  let tableCount = 0;
  let recordCount = 0;

  for (const t of exportedTables()) {
    const file = readExport(t);
    const target = niche.find((n) => n.base_id === t.baseId && n.table_id === t.schema.id);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO archive.legacy_export_tables
           (base_id, base_name, table_id, table_name, field_schema, record_count, exported_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)
         ON CONFLICT (base_id, table_id) DO NOTHING`,
        [t.baseId, t.baseName, t.schema.id, file.table_name, JSON.stringify(t.schema), file.records.length, file.exported_at],
      );
      const archived = await insertRows(client, 'archive.legacy_export_records', 'base_id, table_id, record_id', ARCHIVE_COLUMNS, file.records.map((r) => [
        t.baseId, t.baseName, t.schema.id, file.table_name, r.id, r.createdTime ?? null, JSON.stringify(r.fields), file.exported_at,
      ]));

      let typed = '';
      if (target) {
        const columns: Column[] = [['id', 'text'], ['created_at', 'timestamptz'], ...target.columns.map((c): Column => [c.column, c.pg_type])];
        const rows = file.records.map((r) => [
          r.id,
          r.createdTime,
          ...target.columns.map((c) => {
            const value = convert(c.kind, r.fields[c.field]);
            if (value !== MISFIT) return value;
            // The value doesn't fit the column: store NULL (false for a checkbox) and report it.
            const key = `${target.table}.${c.column} (${c.source_type} as ${c.pg_type})`;
            const issue = issues.get(key) ?? { count: 0, ids: [] };
            issue.count++;
            if (issue.ids.length < 5) issue.ids.push(r.id);
            issues.set(key, issue);
            return c.kind === 'boolean' ? false : null;
          }),
        ]);
        typed = `, ${target.table} +${await insertRows(client, target.table, 'id', columns, rows)}`;
      }

      await client.query('COMMIT');
      tableCount++;
      recordCount += file.records.length;
      console.log(`${t.baseId}/${t.schema.id} ${JSON.stringify(file.table_name)}: ${file.records.length} records, archive +${archived}${typed}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`\n${tableCount} tables, ${recordCount} records read from the export.`);
  if (issues.size === 0) {
    console.log('Value issues: none. Every typed value fit its column.');
  } else {
    console.log('Value issues (stored as NULL, or false for a checkbox):');
    for (const [key, { count, ids }] of issues) console.log(`  ${key}: ${count} records, for example ${ids.join(', ')}`);
    process.exitCode = 2;
  }
}

main()
  .catch((err: unknown) => {
    const e = err as { code?: string; message?: string };
    // Postgres quotes the offending value in some messages. Hide it so lead data never reaches a log.
    const message = String(e.message ?? err).replace(/: ".*"$/s, ': "<value hidden>"');
    console.error(`Load failed${e.code ? ` (${e.code})` : ''}: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
