// Checks the old database export load against the export files. Read-only: it writes nothing.
//   1. Every exported table: archive row counts match the export, and every archived record's
//      fields and createdTime equal the export exactly.
//   2. Every niche_leads table: row count and record ids match the export, and 25 random records
//      match field by field once types are normalized.
//   3. Every stored field in each niche table's the old database schema has a column, and the unique
//      indexes the column map promises exist.
//   4. What migration 0002 added: the verify columns exist with the right types and are empty, each
//      email index is a unique index on (email) that ON CONFLICT (email) can use, and no table has a
//      column that neither the column map nor 0002 explains.
// Prints counts, ids, and field names only, never values. Exits 1 on any failure.
//
//   npx tsx scripts/verify-legacy-load.ts [export_dir]
import { closePool, query } from 'pipeline-db';
import { exportedTables, isBlank, nicheTables, readExport, type Kind } from './legacy-export';

const SAMPLE_SIZE = 25;
const COMPUTED = new Set(['formula', 'rollup', 'lookup', 'multipleLookupValues']);

// What migrations/0002_niche_leads_email_keys_verify_columns.sql adds on top of the old database schemas.
const EMAIL_KEY_TABLES = [
  'financial_advisors_consulti', 'marketing_agencies', 'legal', 'accounting',
  'health_clinics', 'management_consulting', 'staffing_recruiting',
];
const VERIFY_COLUMN_TABLES = ['legal', 'accounting', 'health_clinics', 'management_consulting', 'staffing_recruiting'];
const VERIFY_COLUMNS: [column: string, dataType: string][] = [['email_verified_date', 'date'], ['email_sub_status', 'text']];

let failures = 0;

/** JSON with sorted keys, so key order never counts as a difference. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The value the export says a typed column should hold. */
function expected(kind: Kind, v: unknown): unknown {
  if (isBlank(v)) return kind === 'boolean' ? false : null;
  if (kind === 'timestamptz') return new Date(v as string).toISOString();
  if (kind === 'json_text' && typeof v !== 'string') return JSON.stringify(v);
  return v;
}

/** A database value in the same shape as expected(). */
function actual(kind: Kind, v: unknown): unknown {
  if (v === null) return null;
  if (v instanceof Date) return kind === 'date' ? v.toISOString().slice(0, 10) : v.toISOString();
  if (kind === 'integer' || kind === 'float') return Number(v);
  return v;
}

function sample<T>(items: T[], n: number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

async function main(): Promise<void> {
  const tables = exportedTables();
  const niche = nicheTables();

  console.log('1. Archive: counts and exact field equality, every record');
  let exportRecords = 0;
  for (const t of tables) {
    const file = readExport(t);
    exportRecords += file.records.length;
    const rows = await query<{ record_id: string; created_time: Date | null; fields: unknown }>(
      'SELECT record_id, created_time, fields FROM archive.legacy_export_records WHERE base_id = $1 AND table_id = $2',
      [t.baseId, t.schema.id],
    );
    const [meta] = await query<{ record_count: number; field_schema: unknown }>(
      'SELECT record_count, field_schema FROM archive.legacy_export_tables WHERE base_id = $1 AND table_id = $2',
      [t.baseId, t.schema.id],
    );
    const byId = new Map(rows.map((r) => [r.record_id, r]));
    let missing = 0;
    let fieldDiffs = 0;
    let timeDiffs = 0;
    for (const r of file.records) {
      const row = byId.get(r.id);
      if (!row) { missing++; continue; }
      if (canon(row.fields) !== canon(r.fields)) fieldDiffs++;
      if ((r.createdTime ? Date.parse(r.createdTime) : null) !== (row.created_time?.getTime() ?? null)) timeDiffs++;
    }
    const schemaOk = meta !== undefined && meta.record_count === file.records.length && canon(meta.field_schema) === canon(t.schema);
    const ok = rows.length === file.records.length && missing === 0 && fieldDiffs === 0 && timeDiffs === 0 && schemaOk;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${t.baseId}/${t.schema.id} ${JSON.stringify(t.schema.name)}: export ${file.records.length}, archive ${rows.length}, missing ${missing}, fields differ ${fieldDiffs}, createdTime differs ${timeDiffs}, table row ${schemaOk ? 'ok' : 'wrong or missing'}`);
  }
  const [totals] = await query<{ tables: number; records: number }>(
    'SELECT (SELECT count(*) FROM archive.legacy_export_tables) AS tables, (SELECT count(*) FROM archive.legacy_export_records) AS records',
  );
  const totalsOk = totals?.tables === tables.length && totals?.records === exportRecords;
  if (!totalsOk) failures++;
  console.log(`  ${totalsOk ? 'ok  ' : 'FAIL'} totals: export ${tables.length} tables and ${exportRecords} records; archive ${totals?.tables} tables and ${totals?.records} records`);

  console.log(`\n2. niche_leads: counts, id sets, and ${SAMPLE_SIZE} random records field by field`);
  for (const n of niche) {
    const t = tables.find((x) => x.baseId === n.base_id && x.schema.id === n.table_id);
    if (!t) throw new Error(`${n.table}: its source table is not in the export`);
    const file = readExport(t);
    const ids = new Set((await query<{ id: string }>(`SELECT id FROM ${n.table}`)).map((r) => r.id));
    const missing = file.records.filter((r) => !ids.has(r.id)).length;
    const picked = sample(file.records, SAMPLE_SIZE);
    const rows = await query<Record<string, unknown>>(`SELECT * FROM ${n.table} WHERE id = ANY($1::text[])`, [picked.map((r) => r.id)]);
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    let compared = 0;
    let mismatches = 0;
    const where = new Set<string>();
    for (const r of picked) {
      const row = byId.get(r.id);
      if (!row) { mismatches++; where.add('(row missing)'); continue; }
      compared++;
      if ((row.created_at as Date).getTime() !== Date.parse(r.createdTime ?? '')) { mismatches++; where.add('created_at'); }
      for (const c of n.columns) {
        compared++;
        if (canon(expected(c.kind, r.fields[c.field])) !== canon(actual(c.kind, row[c.column]))) {
          mismatches++;
          where.add(c.field);
        }
      }
    }
    const ok = ids.size === file.records.length && missing === 0 && mismatches === 0;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n.table}: export ${file.records.length}, rows ${ids.size}, export ids missing ${missing}; sampled ${picked.length} records, ${compared} values compared, ${mismatches} mismatches${where.size ? ` in ${[...where].join(', ')}` : ''}`);
  }

  console.log('\n3. niche_leads: column coverage and unique indexes');
  for (const n of niche) {
    const t = tables.find((x) => x.baseId === n.base_id && x.schema.id === n.table_id)!;
    const name = n.table.replace(/^niche_leads\./, '');
    const dbColumns = new Set((await query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'niche_leads' AND table_name = $1",
      [name],
    )).map((r) => r.column_name));
    const stored = t.schema.fields.filter((f) => !COMPUTED.has(f.type));
    const uncovered = stored.filter((f) => {
      const c = n.columns.find((x) => x.field === f.name);
      return !c || !dbColumns.has(c.column);
    });
    const indexes = new Set((await query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'niche_leads' AND tablename = $1 AND indexdef LIKE 'CREATE UNIQUE INDEX%'",
      [name],
    )).map((r) => r.indexname));
    const missingIndexes = n.unique_keys.filter((u) => u.indexed && !indexes.has(`${name}_${u.column}_key`));
    const ok = uncovered.length === 0 && missingIndexes.length === 0;
    if (!ok) failures++;
    const dropped = n.dropped.map((d) => `${d.field} (${d.source_type}: ${d.reason})`).join(', ') || 'none';
    const keys = n.unique_keys.map((u) => `${u.column} ${u.indexed ? 'indexed' : `skipped, ${u.duplicate_rows} duplicate rows`}`).join(', ') || 'none';
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n.table}: ${stored.length} stored fields, ${stored.length - uncovered.length} have a column; dropped: ${dropped}; unique keys: ${keys}`);
    if (uncovered.length) console.log(`       no column for: ${uncovered.map((f) => f.name).join(', ')}`);
    if (missingIndexes.length) console.log(`       missing index on: ${missingIndexes.map((u) => u.column).join(', ')}`);
  }

  console.log('\n4. niche_leads: what migration 0002 added');
  for (const n of niche) {
    const name = n.table.replace(/^niche_leads\./, '');
    const dbColumns = new Map((await query<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'niche_leads' AND table_name = $1",
      [name],
    )).map((r) => [r.column_name, r.data_type]));
    const added = VERIFY_COLUMN_TABLES.includes(name) ? VERIFY_COLUMNS : [];
    const known = new Set(['id', 'created_at', ...n.columns.map((c) => c.column), ...added.map(([column]) => column)]);
    const problems: string[] = [];
    const unexplained = [...dbColumns.keys()].filter((c) => !known.has(c));
    if (unexplained.length) problems.push(`columns neither the column map nor 0002 explains: ${unexplained.join(', ')}`);
    for (const [column, dataType] of added) {
      if (dbColumns.get(column) !== dataType) {
        problems.push(`${column} is ${dbColumns.get(column) ?? 'missing'}, expected ${dataType}`);
        continue;
      }
      const [row] = await query<{ filled: number }>(`SELECT count("${column}")::int AS filled FROM ${n.table}`);
      if (row?.filled !== 0) problems.push(`${column} holds ${row?.filled} values, expected none`);
    }
    const emailKey = EMAIL_KEY_TABLES.includes(name);
    if (emailKey) {
      const [index] = await query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'niche_leads' AND tablename = $1 AND indexname = $2",
        [name, `${name}_email_key`],
      );
      if (!index || !/^CREATE UNIQUE INDEX \S+ ON \S+ USING btree \(email\)$/.test(index.indexdef)) {
        problems.push(`${name}_email_key is missing or is not a unique index on (email)`);
      } else {
        // EXPLAIN plans the insert without running it, so nothing is written. Postgres rejects the plan
        // when no unique index matches the ON CONFLICT column.
        await query(
          `EXPLAIN INSERT INTO ${n.table} (id, created_at, email) VALUES ('recVerifyOnly00000', now(), 'verify@example.invalid') ON CONFLICT (email) DO NOTHING`,
        ).catch((err: unknown) => problems.push(`ON CONFLICT (email) is refused: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    const ok = problems.length === 0;
    if (!ok) failures++;
    const addedText = added.length ? `added ${added.map(([c, t]) => `${c} (${t})`).join(' and ')}` : 'no added columns';
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n.table}: ${dbColumns.size} columns; ${addedText}; ${emailKey ? 'unique email index, ON CONFLICT (email) accepted' : 'no email index'}`);
    for (const p of problems) console.log(`       ${p}`);
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  if (failures) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(`Verify failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
