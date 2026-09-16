// Postgres lead store: reads and writes the niche lead tables (schema niche_leads, pipeline database).
// It uses pipeline-db's shared pool, which finds the connection string on its own
// (PIPELINE_DATABASE_URL, then DATABASE_URL, then /home/casey/.pipeline-db.env).
//
// Rules this module enforces:
//   - Only the tables in LEAD_TABLES can be read or written.
//   - Column names are checked against information_schema before any SQL that uses them runs.
//   - Values are always bound as parameters, never written into the SQL text.
//   - Each write call is one transaction: all of it lands or none of it does. Pass a client that is
//     already inside BEGIN and the call runs as a savepoint in that transaction instead.
//   - Error messages never quote a stored value, so lead data can't end up in a log.
//   - Schema changes are SQL files in migrations/. Nothing here creates tables or columns.
import { randomInt } from 'node:crypto';
import { closePool, getPool } from 'pipeline-db';
import { isLeadTable, LEAD_TABLES, type LeadTable, type SqlFilter } from './lead-tables';

export { isLeadTable, LEAD_TABLES, parseLeadTable, type LeadTable, type SqlFilter } from './lead-tables';

/** One lead: its record id plus column -> value. Empty columns are left out, so `if (row.fields.x)`
 *  and `Object.keys(row.fields)` behave the way they did with the old API. */
export interface LeadRow {
  id: string;
  fields: Record<string, unknown>;
}

/** Columns to change on one existing row. */
export interface LeadUpdate {
  id: string;
  fields: Record<string, unknown>;
}

/** The part of a pg pool or client this module calls. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface WriteOpts {
  /** A client already inside BEGIN. The call runs as a savepoint and the caller commits or rolls back. */
  client?: Queryable;
}

const BATCH = 500;

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const qualified = (table: LeadTable): string => table.split('.').map(ident).join('.');

function assertLeadTable(table: string): asserts table is LeadTable {
  if (!isLeadTable(table)) throw new Error(`refusing table "${table}": only ${LEAD_TABLES.join(', ')} are allowed`);
}

/** Rebuild a Postgres error without any quoted value. Messages like `invalid input syntax for type
 *  bigint: "..."` and the error's detail field can carry lead data, so only the message text (value
 *  hidden), the sqlstate, and the constraint name survive. */
function storeError(table: string, err: unknown): Error {
  const e = err as { code?: string; constraint?: string; message?: string };
  const message = String(e.message ?? err).replace(/: ".*"$/s, ': "<value hidden>"');
  const where = e.code ? ` (sqlstate ${e.code}${e.constraint ? `, ${e.constraint}` : ''})` : '';
  return Object.assign(new Error(`${table}: ${message}${where}`), { code: e.code, constraint: e.constraint });
}

async function run(db: Queryable, table: string, text: string, params: unknown[] = []) {
  try {
    return await db.query(text, params);
  } catch (err) {
    throw storeError(table, err);
  }
}

const REC_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A new record id in the shape every existing row uses: "rec" + 14 letters and digits (the same
 *  shape leads.new_rec_id() makes for the pipeline tables). */
export function newRecId(): string {
  let id = 'rec';
  for (let i = 0; i < 14; i++) id += REC_ALPHABET[randomInt(REC_ALPHABET.length)];
  return id;
}

// ---------------- catalog ----------------

const columnCache = new Map<LeadTable, Set<string>>();
const uniqueCache = new Map<LeadTable, Set<string>>();

/** Every column of a lead table, read from information_schema once per process. */
export async function tableColumns(table: LeadTable, db: Queryable = getPool()): Promise<Set<string>> {
  assertLeadTable(table);
  const cached = columnCache.get(table);
  if (cached) return cached;
  const [schema, name] = table.split('.');
  const res = await run(db, table,
    'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
    [schema, name]);
  if (!res.rows.length) throw new Error(`${table} was not found in the database. Were the migrations in migrations/ applied?`);
  const columns = new Set(res.rows.map((r) => String(r.column_name)));
  columnCache.set(table, columns);
  return columns;
}

/** Columns that a unique index covers on their own (the id primary key included). Only these can be
 *  an ON CONFLICT target. */
async function uniqueColumns(table: LeadTable, db: Queryable): Promise<Set<string>> {
  const cached = uniqueCache.get(table);
  if (cached) return cached;
  const [schema, name] = table.split('.');
  const res = await run(db, table,
    `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
      WHERE n.nspname = $1 AND c.relname = $2 AND i.indisunique
        AND i.indnatts = 1 AND i.indpred IS NULL AND i.indexprs IS NULL`,
    [schema, name]);
  const columns = new Set(res.rows.map((r) => String(r.column_name)));
  uniqueCache.set(table, columns);
  return columns;
}

/** Throws unless the table has every listed column. */
export async function requireColumns(table: LeadTable, columns: string[], db: Queryable = getPool()): Promise<void> {
  const have = await tableColumns(table, db);
  const missing = columns.filter((c) => !have.has(c));
  if (missing.length) throw new Error(`${table} has no column(s) ${missing.join(', ')}. Is this the right table?`);
}

/** Throws unless a unique index covers this one column, so a value in it names at most one row. */
export async function requireUniqueColumn(table: LeadTable, column: string, db: Queryable = getPool()): Promise<void> {
  assertLeadTable(table);
  const unique = await uniqueColumns(table, db);
  if (!unique.has(column)) {
    throw new Error(`${table} has no unique index on (${column}), so rows can't be matched on it (unique columns: ${[...unique].join(', ')})`);
  }
}

// ---------------- read ----------------

export interface FetchOpts {
  /** Columns to return (default: every column). The id always comes back as row.id. */
  columns?: string[];
  /** Row filter. Its $1, $2... placeholders bind to params. */
  where?: SqlFilter;
  client?: Queryable;
}

/** Read lead rows as { id, fields }, ordered by created_at, then id. */
export async function fetchLeads(table: LeadTable, opts: FetchOpts = {}): Promise<LeadRow[]> {
  assertLeadTable(table);
  const db = opts.client ?? getPool();
  const have = await tableColumns(table, db);
  const columns = [...new Set(opts.columns ?? [...have])].filter((c) => c !== 'id');
  const unknown = columns.filter((c) => !have.has(c));
  if (unknown.length) throw new Error(`${table} has no column(s) ${unknown.join(', ')}`);
  if (opts.where?.sql.includes(';')) throw new Error('where.sql must be one condition, with no semicolons');
  const select = ['id', ...columns].map(ident).join(', ');
  const filter = opts.where ? ` WHERE (${opts.where.sql})` : '';
  const res = await run(db, table,
    `SELECT ${select} FROM ${qualified(table)}${filter} ORDER BY "created_at", "id"`,
    opts.where?.params ?? []);
  return res.rows.map((r) => {
    const fields: Record<string, unknown> = {};
    for (const c of columns) if (!isEmpty(r[c])) fields[c] = r[c];
    return { id: String(r.id), fields };
  });
}

// ---------------- write ----------------

let savepointSeq = 0;

async function inTransaction<T>(outer: Queryable | undefined, table: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  if (outer) {
    const savepoint = `lead_store_${++savepointSeq}`;
    await run(outer, table, `SAVEPOINT ${savepoint}`);
    try {
      const out = await fn(outer);
      await run(outer, table, `RELEASE SAVEPOINT ${savepoint}`);
      return out;
    } catch (err) {
      await outer.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
      throw err;
    }
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Drop undefined values and collect any key that isn't a writable column into `bad`. */
function cleanFields(fields: Record<string, unknown>, have: Set<string>, allowId: boolean, bad: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!have.has(key) || key === 'created_at' || (key === 'id' && !allowId)) {
      bad.add(key);
      continue;
    }
    out[key] = value;
  }
  return out;
}

interface Group { columns: string[]; rows: Record<string, unknown>[] }

/** Group rows by the columns they carry (besides id), so each statement writes exactly the columns
 *  its rows supplied and leaves every other column alone. */
function groupByColumns(rows: Record<string, unknown>[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const columns = Object.keys(row).filter((k) => k !== 'id').sort();
    if (!columns.length) continue;
    const key = columns.join(',');
    const group = groups.get(key) ?? { columns, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export interface UpdateOpts extends WriteOpts {
  /** Called after each batch with the running total. */
  onProgress?: (done: number, total: number) => void;
}

/** Update existing rows by id, touching only the columns given. Several updates to one id merge, later
 *  ones winning. Everything runs in one transaction, and an id that isn't in the table fails the whole
 *  call. Returns the number of rows updated. */
export async function updateLeads(table: LeadTable, updates: LeadUpdate[], opts: UpdateOpts = {}): Promise<number> {
  assertLeadTable(table);
  if (!updates.length) return 0;
  const have = await tableColumns(table, opts.client);
  const bad = new Set<string>();
  const merged = new Map<string, Record<string, unknown>>();
  for (const u of updates) {
    if (!u.id) throw new Error(`${table}: an update has no id`);
    merged.set(u.id, { ...merged.get(u.id), ...cleanFields(u.fields, have, false, bad) });
  }
  if (bad.size) throw new Error(`${table}: can't write column(s) ${[...bad].join(', ')}`);
  const groups = groupByColumns([...merged].map(([id, fields]) => ({ ...fields, id })));
  const total = groups.reduce((sum, g) => sum + g.rows.length, 0);

  return inTransaction(opts.client, table, async (db) => {
    let done = 0;
    for (const { columns, rows } of groups) {
      const assignments = columns.map((c) => `${ident(c)} = v.${ident(c)}`).join(', ');
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const res = await run(db, table,
          `UPDATE ${qualified(table)} AS t SET ${assignments} ` +
          `FROM jsonb_populate_recordset(NULL::${qualified(table)}, $1::jsonb) AS v ` +
          `WHERE t."id" = v."id" RETURNING t."id"`,
          [JSON.stringify(batch)]);
        if (res.rows.length !== batch.length) {
          const found = new Set(res.rows.map((r) => String(r.id)));
          const missing = batch.map((r) => String(r.id)).filter((id) => !found.has(id));
          throw new Error(`${table}: ${missing.length} of ${batch.length} ids not found (for example ${missing.slice(0, 3).join(', ')}). Nothing was written.`);
        }
        done += batch.length;
        opts.onProgress?.(done, total);
      }
    }
    return done;
  });
}

export interface UpsertResult { inserted: number; updated: number }

async function insertGroups(db: Queryable, table: LeadTable, rows: Record<string, unknown>[], conflictColumn: string | null): Promise<UpsertResult> {
  const result: UpsertResult = { inserted: 0, updated: 0 };
  for (const { columns, rows: groupRows } of groupByColumns(rows)) {
    const target = ['id', 'created_at', ...columns].map(ident).join(', ');
    const source = ['v."id"', 'now()', ...columns.map((c) => `v.${ident(c)}`)].join(', ');
    let onConflict = '';
    if (conflictColumn) {
      const set = columns.filter((c) => c !== conflictColumn);
      const assignments = (set.length ? set : [conflictColumn]).map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ');
      onConflict = ` ON CONFLICT (${ident(conflictColumn)}) DO UPDATE SET ${assignments}`;
    }
    for (let i = 0; i < groupRows.length; i += BATCH) {
      const batch = groupRows.slice(i, i + BATCH);
      const res = await run(db, table,
        `INSERT INTO ${qualified(table)} AS t (${target}) ` +
        `SELECT ${source} FROM jsonb_populate_recordset(NULL::${qualified(table)}, $1::jsonb) AS v` +
        `${onConflict} RETURNING (t.xmax = 0) AS inserted`,
        [JSON.stringify(batch)]);
      for (const r of res.rows) {
        if (r.inserted === true) result.inserted++;
        else result.updated++;
      }
    }
  }
  return result;
}

/** Insert rows, or update the existing row whose conflictColumn matches. Each row maps column -> value.
 *  A column a row leaves out stays as it is on update and empty on insert. conflictColumn needs a
 *  unique index of its own (the id primary key counts). New rows get a fresh rec id and
 *  created_at = now(). Rows that share a conflict value merge first, later rows winning. When merging on
 *  id, a row without an id is new, and it's inserted with a plain INSERT so an id clash fails instead
 *  of overwriting. Everything runs in one transaction. */
export async function upsertLeads(
  table: LeadTable,
  rows: Record<string, unknown>[],
  conflictColumn: string,
  opts: WriteOpts = {},
): Promise<UpsertResult> {
  assertLeadTable(table);
  if (!rows.length) return { inserted: 0, updated: 0 };
  const db = opts.client ?? getPool();
  const have = await tableColumns(table, db);
  if (!have.has(conflictColumn)) throw new Error(`${table} has no column ${conflictColumn}`);
  const unique = await uniqueColumns(table, db);
  if (!unique.has(conflictColumn)) {
    throw new Error(`${table} has no unique index on (${conflictColumn}), so rows can't be merged on it (unique columns: ${[...unique].join(', ')})`);
  }

  const bad = new Set<string>();
  const merged = new Map<string, Record<string, unknown>>();
  const fresh: Record<string, unknown>[] = [];
  let missingKey = 0;
  for (const row of rows) {
    const clean = cleanFields(row, have, true, bad);
    if (conflictColumn === 'id' && isEmpty(clean.id)) {
      fresh.push({ ...clean, id: newRecId() });
      continue;
    }
    if (isEmpty(clean[conflictColumn])) {
      missingKey++;
      continue;
    }
    const key = JSON.stringify(clean[conflictColumn]);
    merged.set(key, { ...merged.get(key), ...clean });
  }
  if (bad.size) throw new Error(`${table}: can't write column(s) ${[...bad].join(', ')}`);
  if (missingKey) throw new Error(`${table}: ${missingKey} row(s) have no ${conflictColumn} to merge on. Nothing was written.`);
  const keyed = [...merged.values()].map((r) => (isEmpty(r.id) ? { ...r, id: newRecId() } : r));

  return inTransaction(opts.client, table, async (tx) => {
    const merges = await insertGroups(tx, table, keyed, conflictColumn);
    const inserts = await insertGroups(tx, table, fresh, null);
    return { inserted: merges.inserted + inserts.inserted, updated: merges.updated + inserts.updated };
  });
}

/** Delete rows by id in one transaction. Returns how many rows were deleted; an id that's already gone
 *  just isn't counted. */
export async function deleteLeads(table: LeadTable, ids: string[], opts: WriteOpts = {}): Promise<number> {
  assertLeadTable(table);
  const unique = [...new Set(ids)];
  if (!unique.length) return 0;
  return inTransaction(opts.client, table, async (db) => {
    let deleted = 0;
    for (let i = 0; i < unique.length; i += 1000) {
      const res = await run(db, table, `DELETE FROM ${qualified(table)} WHERE "id" = ANY($1::text[])`, [unique.slice(i, i + 1000)]);
      deleted += res.rowCount ?? 0;
    }
    return deleted;
  });
}

/** Close the shared pool so a CLI process can exit. Safe to call when nothing connected. */
export function closeLeadStore(): Promise<void> {
  return closePool();
}
