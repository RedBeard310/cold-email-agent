-- Hand-written follow-up to 0001_niche_leads.sql. Not generated.
-- 0001 copied each Airtable table's fields exactly. The code moving off the Airtable API needs two
-- more things, and this file adds them.
-- Apply once, after 0001: psql -v ON_ERROR_STOP=1 -f migrations/0002_niche_leads_email_keys_verify_columns.sql
-- Section 4 of scripts/verify-legacy-load.ts checks both changes.
BEGIN;

-- 1. A unique email index on the 7 tables the Consulti loader writes to.
--    src/consulti/airtable.ts upserts with fieldsToMergeOn ['email']. The Postgres version is
--    INSERT ... ON CONFLICT (email), and Postgres refuses that unless a unique index covers exactly (email).
--    Checked 2026-09-13 before adding: in all 7 tables no email repeats, even after lowercasing and
--    trimming, and no email is an empty string. A row with no email holds NULL, and a unique index
--    allows any number of NULLs (marketing_agencies has 14 such rows).
--    The index is case-sensitive. Every stored email is already lowercase and trimmed, and the Consulti
--    pull lowercases and trims before it writes (src/consulti/pull.ts). The port has to keep doing that.
--    financial_advisors gets no email index, because 34 emails repeat there across 172 extra rows.
CREATE UNIQUE INDEX financial_advisors_consulti_email_key ON niche_leads.financial_advisors_consulti ("email");
CREATE UNIQUE INDEX marketing_agencies_email_key          ON niche_leads.marketing_agencies ("email");
CREATE UNIQUE INDEX legal_email_key                       ON niche_leads.legal ("email");
CREATE UNIQUE INDEX accounting_email_key                  ON niche_leads.accounting ("email");
CREATE UNIQUE INDEX health_clinics_email_key              ON niche_leads.health_clinics ("email");
CREATE UNIQUE INDEX management_consulting_email_key       ON niche_leads.management_consulting ("email");
CREATE UNIQUE INDEX staffing_recruiting_email_key         ON niche_leads.staffing_recruiting ("email");

COMMENT ON INDEX niche_leads.marketing_agencies_email_key IS
  'Two ingest paths write this table. Consulti rows merge on email. Apollo rows merge on apollo_person_id (src/apollo/airtable.ts), so an Apollo insert whose email is already in the table fails on this index instead of merging. The port has to pick the conflict target for each path.';

-- 2. email_verified_date and email_sub_status on the 5 tables that never had them.
--    In Airtable, src/verify/emails.ts created both fields while it ran, through the Meta API
--    (ensureSchema), and src/consulti/verify.ts filters on {email_verified_date}=BLANK().
--    Postgres code can't add columns as it runs, so they're added here, with the types verify:emails
--    gave them in marketing_agencies. The port should drop the ensureSchema step.
--    Every row in these 5 tables has email_status 'not_checked', so both columns start empty.
ALTER TABLE niche_leads.legal                 ADD COLUMN email_verified_date date, ADD COLUMN email_sub_status text;
ALTER TABLE niche_leads.accounting            ADD COLUMN email_verified_date date, ADD COLUMN email_sub_status text;
ALTER TABLE niche_leads.health_clinics        ADD COLUMN email_verified_date date, ADD COLUMN email_sub_status text;
ALTER TABLE niche_leads.management_consulting ADD COLUMN email_verified_date date, ADD COLUMN email_sub_status text;
ALTER TABLE niche_leads.staffing_recruiting   ADD COLUMN email_verified_date date, ADD COLUMN email_sub_status text;

COMMENT ON COLUMN niche_leads.legal.email_verified_date                 IS 'Added by migration 0002 for the email verify commands. The Airtable table never had this field.';
COMMENT ON COLUMN niche_leads.legal.email_sub_status                    IS 'Added by migration 0002 for the email verify commands. The Airtable table never had this field.';
COMMENT ON COLUMN niche_leads.accounting.email_verified_date            IS 'Added by migration 0002 for the email verify commands. The Airtable table never had this field.';
COMMENT ON COLUMN niche_leads.accounting.email_sub_status               IS 'Added by migration 0002 for the email verify commands. The Airtable table never had this field.';
COMMENT ON COLUMN niche_leads.health_clinics.email_verified_date        IS 'Added by migration 0002 for the email verify commands. The Airtable table never had this field.';
COMMENT ON COLUMN niche_leads.health_clinics.email_sub_status           IS 'Added by migration 0002 for the email verify commands. The Airtable table never had this field.';
COMMENT ON COLUMN niche_leads.management_consulting.email_verified_date IS 'Added by migration 0002 for the email verify commands. The Airtable table never had this field.';
COMMENT ON COLUMN niche_leads.management_consulting.email_sub_status    IS 'Added by migration 0002 for the email verify commands. The Airtable table never had this field.';
COMMENT ON COLUMN niche_leads.staffing_recruiting.email_verified_date   IS 'Added by migration 0002 for the email verify commands. The Airtable table never had this field.';
COMMENT ON COLUMN niche_leads.staffing_recruiting.email_sub_status      IS 'Added by migration 0002 for the email verify commands. The Airtable table never had this field.';

COMMIT;
