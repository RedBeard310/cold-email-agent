-- Archive of the final Airtable export, taken 2026-09-13 after the Airtable account was canceled.
-- It holds every Airtable record that was not already in Postgres at that point: the 7 cold-email
-- lead bases, the "CGC - D100 Generation" base, 18 Dream 100 tables from the lead base, and the
-- 5 deep-research client bases that never reached the research schema.
-- Filled by scripts/load-legacy-export.ts. Apply once:
--   psql -v ON_ERROR_STOP=1 -f migrations/0000_archive.sql
BEGIN;

CREATE SCHEMA archive;
COMMENT ON SCHEMA archive IS 'Frozen copy of the final Airtable export, taken 2026-09-13.';

CREATE TABLE archive.airtable_tables (
  base_id      text        NOT NULL,
  base_name    text        NOT NULL,
  table_id     text        NOT NULL,
  table_name   text        NOT NULL,
  field_schema jsonb       NOT NULL,  -- the table object from the base's _schema.json (Airtable Meta API)
  record_count bigint      NOT NULL,
  exported_at  timestamptz NOT NULL,
  PRIMARY KEY (base_id, table_id)
);

CREATE TABLE archive.airtable_records (
  base_id      text        NOT NULL,
  base_name    text        NOT NULL,
  table_id     text        NOT NULL,
  table_name   text        NOT NULL,
  record_id    text        NOT NULL,
  created_time timestamptz,
  fields       jsonb       NOT NULL,  -- the record's fields exactly as exported, keyed by field name
  exported_at  timestamptz NOT NULL,
  PRIMARY KEY (base_id, table_id, record_id)
);

COMMENT ON TABLE archive.airtable_tables IS
  'Lossless copy of every Airtable record that was not already in Postgres when Airtable was canceled, exported 2026-09-13. This table has one row per exported table: its field schema and record count.';
COMMENT ON TABLE archive.airtable_records IS
  'Lossless copy of every Airtable record that was not already in Postgres when Airtable was canceled, exported 2026-09-13. This table has one row per record, with its fields kept as JSON keyed by field name.';

COMMIT;
