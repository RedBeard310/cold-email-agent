-- Applied 2026-09-29. Renames the columns and tables that still carried the
-- name of the pre-Postgres store. Data is untouched: these are metadata-only
-- renames, run in one transaction after checking that no view, materialized
-- view or function referenced them.
--
--   <schema>.<table>.airtable_created_time -> legacy_created_time   (29 tables)
--   research.clients.airtable_base_id      -> legacy_base_id
--   archive.airtable_records               -> archive.legacy_export_records
--   archive.airtable_tables                -> archive.legacy_export_tables
--
-- The earlier migration files in this folder still create the old names. They
-- are left as written because applied migrations are a record of what ran.
-- A rebuild from scratch replays them and then this file.

ALTER TABLE archive.airtable_records RENAME TO legacy_export_records;
ALTER TABLE archive.airtable_tables  RENAME TO legacy_export_tables;
ALTER INDEX archive.airtable_records_pkey RENAME TO legacy_export_records_pkey;
ALTER INDEX archive.airtable_tables_pkey  RENAME TO legacy_export_tables_pkey;
