-- Phase 12 A (M22): super-admin (platform operator), SaaS plans/subscriptions/invoices, impersonation with consent, DPDP tooling.
-- Platform tables are GLOBAL (no tenant_id RLS) and are NOT granted to worko_app (only the plan catalogue is readable).
-- Tenant-facing tables follow the tenant conventions (sync columns, make_tenant_table, grants).

-- ---------- Tenant status + subscription (platform-owned columns on the global tenant row) ----------
ALTER TABLE tenant
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  ADD COLUMN suspended_at timestamptz, ADD COLUMN suspended_reason text,
  ADD COLUMN sub_status text NOT NULL DEFAULT 'trial' CHECK (sub_status IN ('trial','active','past_due','suspended','cancelled')),
  ADD COLUMN billing_cycle text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','annual')),
  ADD COLUMN trial_ends_on date, ADD COLUMN period_start date, ADD COLUMN period_end date,
  ADD COLUMN past_due_since date, ADD COLUMN sub_suspended_since date, ADD COLUMN cancelled_at timestamptz;
-- Existing tenants: 30-day trial from today (sample; the platform admin assigns real plans).
UPDATE tenant SET trial_ends_on = (now() AT TIME ZONE 'Asia/Kolkata')::date + 30 WHERE trial_ends_on IS NULL;
-- New firms start on the trial plan; SaasService.startTrial sets the date from saas.lifecycle.trialDays (this default is a fallback).
ALTER TABLE tenant ALTER COLUMN trial_ends_on SET DEFAULT ((now() AT TIME ZONE 'Asia/Kolkata')::date + 30);

-- ---------- Platform principal (separate from firm staff) ----------
CREATE TABLE platform_admin (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL, password_hash text NOT NULL,
  totp_secret_enc bytea NOT NULL, totp_last_step bigint,           -- MFA is mandatory: no row without a TOTP secret
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_logins int NOT NULL DEFAULT 0, locked_until timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_session (
  id uuid PRIMARY KEY, admin_id uuid NOT NULL REFERENCES platform_admin(id),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz, ip inet, user_agent text
);
CREATE TABLE platform_audit_log (
  seq bigserial PRIMARY KEY, at timestamptz NOT NULL, admin_id uuid, tenant_id uuid, action text NOT NULL, entity text NOT NULL, entity_id text,
  diff jsonb, ip inet, prev_hash bytea, hash bytea NOT NULL
);
CREATE INDEX ON platform_audit_log (tenant_id, seq);
CREATE TABLE platform_setting (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

-- ---------- Plans + price rate table (DATA; sample values UNVERIFIED) ----------
CREATE TABLE saas_plan (
  key text PRIMARY KEY, name text NOT NULL, seats int CHECK (seats IS NULL OR seats > 0), storage_gb int CHECK (storage_gb IS NULL OR storage_gb > 0),
  portal_users_count_as_seats boolean NOT NULL DEFAULT false, modules jsonb NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true, sort int NOT NULL DEFAULT 0
);
CREATE TABLE saas_plan_price (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_key text NOT NULL REFERENCES saas_plan(key), cycle text NOT NULL CHECK (cycle IN ('monthly','annual')),
  price_paise bigint NOT NULL CHECK (price_paise >= 0), effective_from date NOT NULL, unverified boolean NOT NULL DEFAULT true, notes text,
  UNIQUE (plan_key, cycle, effective_from)
);
INSERT INTO saas_plan (key, name, seats, storage_gb, portal_users_count_as_seats, modules, sort) VALUES
  ('trial', 'Trial', 25, 5, false, '{"portal":true,"automation":true,"ai":true,"payments":true,"whatsapp":true,"esign":true,"leads":true,"reports":true}', 0),
  ('starter', 'Starter', 5, 20, false, '{"portal":true,"automation":false,"ai":false,"payments":true,"whatsapp":false,"esign":false,"leads":true,"reports":true}', 1),
  ('professional', 'Professional', 25, 200, false, '{"portal":true,"automation":true,"ai":true,"payments":true,"whatsapp":true,"esign":true,"leads":true,"reports":true}', 2),
  ('enterprise', 'Enterprise', NULL, 2000, false, '{"portal":true,"automation":true,"ai":true,"payments":true,"whatsapp":true,"esign":true,"leads":true,"reports":true}', 3);
INSERT INTO saas_plan_price (plan_key, cycle, price_paise, effective_from, notes) VALUES
  ('trial', 'monthly', 0, '2026-01-01', 'Free trial'),
  ('starter', 'monthly', 99900, '2026-01-01', 'SAMPLE PRICE — UNVERIFIED'), ('starter', 'annual', 999000, '2026-01-01', 'SAMPLE PRICE — UNVERIFIED'),
  ('professional', 'monthly', 349900, '2026-01-01', 'SAMPLE PRICE — UNVERIFIED'), ('professional', 'annual', 3499000, '2026-01-01', 'SAMPLE PRICE — UNVERIFIED'),
  ('enterprise', 'monthly', 999900, '2026-01-01', 'SAMPLE PRICE — UNVERIFIED'), ('enterprise', 'annual', 9999000, '2026-01-01', 'SAMPLE PRICE — UNVERIFIED');
-- Supplier (Worko's own GST registration) + lifecycle settings: data, sample values.
INSERT INTO platform_setting (key, value) VALUES
  ('saas.supplier', '{"name":"Worko Software (SAMPLE)","gstin":null,"stateCode":"27","address":"SAMPLE ADDRESS — configure","sac":"998314","gstRate":18,"invoicePrefix":"WKO"}'),
  ('saas.lifecycle', '{"trialDays":30,"invoiceDueDays":7,"graceDays":15,"cancelAfterDays":60,"dunningDays":[0,3,7,14],"conversionPlan":"starter"}');
CREATE TABLE saas_invoice_counter (fy int PRIMARY KEY, last int NOT NULL DEFAULT 0);
-- Payment link → tenant (webhooks arrive without a tenant).
CREATE TABLE saas_payment_link (link_id text PRIMARY KEY, provider text NOT NULL, tenant_id uuid NOT NULL REFERENCES tenant(id), invoice_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE saas_payment_event (provider text NOT NULL, event_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (provider, event_id));

GRANT SELECT ON saas_plan TO worko_app;

-- ---------- Tenant-facing SaaS tables ----------
CREATE TABLE saas_invoice (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  number text NOT NULL UNIQUE, issue_date date NOT NULL, due_date date NOT NULL, period_start date NOT NULL, period_end date NOT NULL,
  plan_key text NOT NULL, cycle text NOT NULL, supply_type text NOT NULL,
  supplier jsonb NOT NULL, bill_to jsonb NOT NULL,
  taxable_paise bigint NOT NULL, cgst_paise bigint NOT NULL, sgst_paise bigint NOT NULL, igst_paise bigint NOT NULL, round_off_paise bigint NOT NULL, total_paise bigint NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','paid','void')),
  paid_at timestamptz, provider text, payment_link_id text, payment_url text, provider_payment_id text,
  dunning_sent int NOT NULL DEFAULT 0, last_dunning_on date,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('saas_invoice');
CREATE TABLE saas_usage (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), month text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  seats int NOT NULL, portal_users int NOT NULL, storage_bytes bigint NOT NULL, messages int NOT NULL, ai_calls int NOT NULL, ai_cost_paise bigint NOT NULL,
  computed_at timestamptz NOT NULL,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, UNIQUE (tenant_id, month)
);
CALL make_tenant_table('saas_usage');
CREATE TABLE saas_upgrade_request (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), plan_key text NOT NULL, cycle text NOT NULL CHECK (cycle IN ('monthly','annual')),
  note text, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','declined')), requested_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('saas_upgrade_request');

-- ---------- Impersonation (consent records are retained; never deleted) ----------
CREATE TABLE impersonation_grant (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  platform_admin_id uuid NOT NULL, admin_name text NOT NULL, reason text NOT NULL,
  requested_write boolean NOT NULL DEFAULT false, duration_minutes int NOT NULL CHECK (duration_minutes BETWEEN 5 AND 240),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','denied','revoked','expired')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES app_user(id), decided_at timestamptz, write_consent boolean NOT NULL DEFAULT false, as_user_id uuid REFERENCES app_user(id),
  expires_at timestamptz, revoked_by uuid, revoked_at timestamptz, first_used_at timestamptz, actions int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('impersonation_grant');

-- ---------- DPDP ----------
CREATE TABLE dpdp_settings (tenant_id uuid PRIMARY KEY REFERENCES tenant(id), settings jsonb NOT NULL, retention jsonb NOT NULL DEFAULT '{}', updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE dpdp_settings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dpdp_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE dpdp_request (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('access','correction','erasure','grievance')),
  principal_type text NOT NULL CHECK (principal_type IN ('client','contact','lead','portal_user','staff')), principal_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('staff','portal')), portal_user_id uuid REFERENCES portal_user(id),
  details_enc bytea,                                -- free text from the principal (KeyService; never in audit)
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_progress','completed','partially_completed','rejected')),
  received_on date NOT NULL, due_on date NOT NULL, assigned_to uuid REFERENCES app_user(id),
  outcome jsonb NOT NULL DEFAULT '{}',              -- ids/counts/reasons only
  resolution_enc bytea, closed_at timestamptz, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('dpdp_request');
CREATE INDEX ON dpdp_request (tenant_id, status, due_on);

CREATE TABLE dpdp_export (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), request_id uuid NOT NULL REFERENCES dpdp_request(id),
  token_hash text NOT NULL UNIQUE, body_enc bytea NOT NULL, expires_at timestamptz NOT NULL, downloads int NOT NULL DEFAULT 0,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('dpdp_export');
-- Public download looks the token up before knowing the tenant.
CREATE TABLE dpdp_export_index (token_hash text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id));

CREATE TABLE dpdp_breach (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  title text NOT NULL, description_enc bytea, severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  occurred_at timestamptz, aware_at timestamptz NOT NULL, report_due_at timestamptz NOT NULL,
  affected_count int NOT NULL DEFAULT 0 CHECK (affected_count >= 0), data_categories text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','contained','closed')),
  board_notified_at timestamptz, principals_notified_at timestamptz, principals_notified_count int NOT NULL DEFAULT 0,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('dpdp_breach');

CREATE TABLE dpdp_purge_run (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), dry_run boolean NOT NULL, as_of date NOT NULL,
  counts jsonb NOT NULL, run_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('dpdp_purge_run');

GRANT SELECT, INSERT, UPDATE ON saas_invoice, saas_usage, saas_upgrade_request, impersonation_grant, dpdp_settings, dpdp_request, dpdp_export, dpdp_breach, dpdp_purge_run TO worko_app;
-- Purge job deletes expired OTP challenges / export bundles inside tenantTx.
GRANT DELETE ON dpdp_export, otp_challenge, portal_otp TO worko_app;

-- One daily SaaS lifecycle job per tenant.
CREATE UNIQUE INDEX job_queue_saas_one ON job_queue (tenant_id, kind) WHERE kind = 'saas.daily' AND dead_at IS NULL;
