-- Phase 11 (M17 dashboards & reports, M21 NL query). Definitions are data compiled server-side to parameterised SQL over a
-- whitelist; every run re-applies the VIEWER's row scope (D160–D169). REST-only (not synced; sync columns per convention).

-- ---------- Saved reports (report builder) ----------
CREATE TABLE saved_report (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120), description text,
  owner_id uuid NOT NULL REFERENCES app_user(id),
  definition jsonb NOT NULL, current_version int NOT NULL DEFAULT 1,
  -- Sharing never shares the owner's scope: whoever opens it sees only their own rows (D161).
  shared_firm boolean NOT NULL DEFAULT false, shared_roles text[] NOT NULL DEFAULT '{}', shared_user_ids uuid[] NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'builder' CHECK (source IN ('builder','catalogue','nl_query')), catalogue_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('saved_report');
CREATE INDEX ON saved_report (tenant_id, owner_id) WHERE deleted_at IS NULL;

CREATE TABLE saved_report_version (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), report_id uuid NOT NULL REFERENCES saved_report(id),
  report_version int NOT NULL, name text NOT NULL, definition jsonb NOT NULL, changed_by uuid, changed_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, report_id, report_version)
);
CALL make_tenant_table('saved_report_version');

-- ---------- Dashboards ----------
CREATE TABLE dashboard (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  owner_id uuid REFERENCES app_user(id),   -- personal dashboard
  role_key text,                           -- role-default dashboard (partner / manager / article …)
  widgets jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  CHECK ((owner_id IS NULL) <> (role_key IS NULL))
);
CALL make_tenant_table('dashboard');
CREATE UNIQUE INDEX dashboard_role_default ON dashboard (tenant_id, role_key) WHERE role_key IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE dashboard_default (
  tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id), dashboard_id uuid NOT NULL REFERENCES dashboard(id),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, user_id)
);
CALL make_tenant_table('dashboard_default');

-- ---------- Scheduled reports ----------
CREATE TABLE report_schedule (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120), owner_id uuid NOT NULL REFERENCES app_user(id),
  report_id uuid REFERENCES saved_report(id), catalogue_key text, params jsonb NOT NULL DEFAULT '{}',
  schedule jsonb NOT NULL,                 -- reportScheduleSchema (IST)
  recipient_ids uuid[] NOT NULL CHECK (cardinality(recipient_ids) BETWEEN 1 AND 50),
  delivery text NOT NULL DEFAULT 'email' CHECK (delivery IN ('email','in_app')),
  format text NOT NULL DEFAULT 'xlsx' CHECK (format IN ('csv','xlsx','pdf')),
  link_ttl_days int NOT NULL DEFAULT 7 CHECK (link_ttl_days BETWEEN 1 AND 30),
  enabled boolean NOT NULL DEFAULT true, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')), paused_reason text,
  consecutive_failures int NOT NULL DEFAULT 0, next_run_at timestamptz, last_run_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  CHECK ((report_id IS NULL) <> (catalogue_key IS NULL))
);
CALL make_tenant_table('report_schedule');

-- One row per schedule × period × recipient: the idempotency key of a delivery (a re-run of the same period is a no-op).
CREATE TABLE report_schedule_run (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), schedule_id uuid NOT NULL REFERENCES report_schedule(id),
  period_key text NOT NULL, recipient_id uuid NOT NULL REFERENCES app_user(id), occurrence_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','delivered','skipped','failed')), skip_reason text,
  row_count int, export_id uuid, message_id uuid, notification_id uuid, error text,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, schedule_id, period_key, recipient_id)
);
CALL make_tenant_table('report_schedule_run');
CREATE INDEX ON report_schedule_run (schedule_id, started_at DESC);

-- A rendered export behind a recipient-bound, expiring download link (the e-mail carries the link, never the file).
CREATE TABLE report_export (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  schedule_id uuid REFERENCES report_schedule(id), run_id uuid,
  name text NOT NULL, mime text NOT NULL, size_bytes int NOT NULL, row_count int NOT NULL,
  body_enc bytea NOT NULL,                 -- KeyService, AAD report_export:<id>:body
  token_hash text NOT NULL,                -- sha256 of the link token; the token itself is only in the link
  expires_at timestamptz NOT NULL, downloads int NOT NULL DEFAULT 0, last_downloaded_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, token_hash)
);
CALL make_tenant_table('report_export');

-- ---------- NL query (M21) ----------
CREATE TABLE report_ask (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  question_enc bytea NOT NULL,             -- KeyService, AAD report_ask:<id>:question
  definition_enc bytea,                    -- KeyService, AAD report_ask:<id>:definition (filter values may name a client)
  status text NOT NULL CHECK (status IN ('proposed','invalid','saved')),
  dataset text, sources jsonb NOT NULL DEFAULT '[]', issues jsonb NOT NULL DEFAULT '[]',
  provider text, model text, cost_paise bigint NOT NULL DEFAULT 0, saved_report_id uuid REFERENCES saved_report(id), created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('report_ask');
CREATE INDEX ON report_ask (tenant_id, user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON saved_report, saved_report_version, dashboard, dashboard_default, report_schedule, report_schedule_run, report_export, report_ask TO worko_app;
GRANT DELETE ON dashboard_default TO worko_app;

-- Articles and seniors get "my work" reports over their own scope (D160): reports:view own (+ create/edit own for seniors).
UPDATE role SET grants = grants || '[{"module":"reports","action":"view","scope":"own"}]'::jsonb
  WHERE system AND key IN ('article','senior') AND NOT grants @> '[{"module":"reports","action":"view"}]'::jsonb;
UPDATE role SET grants = grants || '[{"module":"reports","action":"create","scope":"own"},{"module":"reports","action":"edit","scope":"own"}]'::jsonb
  WHERE system AND key = 'senior' AND NOT grants @> '[{"module":"reports","action":"create"}]'::jsonb;
