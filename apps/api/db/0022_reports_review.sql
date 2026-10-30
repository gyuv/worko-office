-- Phase 11 review. Exports are re-rendered AS THE DOWNLOADER at download time (D171): no stored file, so revoked access
-- (client visibility, roles, field hiding) applies immediately; the link only names the schedule × period × recipient.
ALTER TABLE report_export ALTER COLUMN body_enc DROP NOT NULL, ADD COLUMN format text, ADD COLUMN period_key text;
UPDATE report_export SET body_enc = NULL, format = COALESCE(format, CASE WHEN mime LIKE 'text/csv%' THEN 'csv' WHEN mime = 'application/pdf' THEN 'pdf' ELSE 'xlsx' END);
ALTER TABLE report_export ADD CONSTRAINT report_export_format CHECK (format IN ('csv','xlsx','pdf'));
-- Stale-lease reclaim of runs left 'running' (crash between claim and finish).
CREATE INDEX report_schedule_run_running ON report_schedule_run (tenant_id, schedule_id, started_at) WHERE status = 'running';
GRANT DELETE ON report_export TO worko_app;
