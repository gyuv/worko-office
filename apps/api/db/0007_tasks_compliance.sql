-- Phase 4: service catalogue, client subscriptions, tasks, to-dos, rule packs, due-date extensions.
-- Synced tables carry field_versions. Prices are never stored here (billing rate tables arrive with M7).

CREATE TABLE service_type (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  key text NOT NULL, name text NOT NULL, category text NOT NULL DEFAULT 'Compliance', description text,
  frequency text NOT NULL CHECK (frequency IN ('monthly','quarterly','annual','one_time','event')),
  rule_id text,                       -- optional explicit link to a rule id; otherwise rules link by serviceTypeKey = key
  sla_days int CHECK (sla_days BETWEEN 0 AND 365),
  default_checks jsonb NOT NULL DEFAULT '[]',
  leader_id uuid REFERENCES app_user(id), manager_id uuid REFERENCES app_user(id), reviewer_id uuid REFERENCES app_user(id), assignee_id uuid REFERENCES app_user(id),
  billable boolean NOT NULL DEFAULT true, active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('service_type');
CREATE UNIQUE INDEX service_type_key ON service_type (tenant_id, key) WHERE deleted_at IS NULL;

CREATE TABLE client_service (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  client_id uuid NOT NULL REFERENCES client(id), service_type_id uuid NOT NULL REFERENCES service_type(id),
  start_period text CHECK (start_period ~ '^\d{4}-\d{2}$'), end_period text CHECK (end_period ~ '^\d{4}-\d{2}$'),
  leader_id uuid REFERENCES app_user(id), manager_id uuid REFERENCES app_user(id), reviewer_id uuid REFERENCES app_user(id), assignee_id uuid REFERENCES app_user(id),
  active boolean NOT NULL DEFAULT true, notes text,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('client_service');
CREATE UNIQUE INDEX client_service_unique ON client_service (tenant_id, client_id, service_type_id) WHERE deleted_at IS NULL;
CREATE INDEX ON client_service (service_type_id);

CREATE TABLE task (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  client_id uuid REFERENCES client(id),                       -- NULL = firm/internal task
  service_type_id uuid REFERENCES service_type(id), period_key text, period_label text,
  title text NOT NULL, description text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','pending_client','review','done','cancelled')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  statutory_due date, act_by date CHECK (act_by IS NULL OR statutory_due IS NULL OR act_by <= statutory_due),
  leader_id uuid REFERENCES app_user(id), manager_id uuid REFERENCES app_user(id), assignee_id uuid REFERENCES app_user(id), reviewer_id uuid REFERENCES app_user(id),
  checks jsonb NOT NULL DEFAULT '[]', pending_issue text,
  outcome text CHECK (outcome IN ('billed','free','deleted')), outcome_note text, closed_at timestamptz, closed_by uuid,
  completed_at timestamptz,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('auto','manual')),
  rule_id text, extension_id uuid, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('task');
-- Idempotent auto-creation: one live task per client × service × period.
CREATE UNIQUE INDEX task_auto_unique ON task (tenant_id, client_id, service_type_id, period_key) WHERE deleted_at IS NULL;
CREATE INDEX task_open_due ON task (tenant_id, statutory_due) WHERE deleted_at IS NULL AND outcome IS NULL;
CREATE INDEX ON task (tenant_id, assignee_id) WHERE deleted_at IS NULL;
CREATE INDEX ON task (client_id);
CREATE INDEX ON task (tenant_id, rule_id, period_key) WHERE deleted_at IS NULL;

-- Server-side snapshots behind "undo" of a bulk change (10 minutes).
CREATE TABLE task_bulk_undo (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  snapshot jsonb NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE task_bulk_undo ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON task_bulk_undo USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE todo (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), owner_id uuid NOT NULL REFERENCES app_user(id),
  title text NOT NULL, notes text, due_at timestamptz, done boolean NOT NULL DEFAULT false, done_at timestamptz,
  task_id uuid REFERENCES task(id), sort int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('todo');
CREATE INDEX ON todo (tenant_id, owner_id) WHERE deleted_at IS NULL;

CREATE TABLE todo_template (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL, items jsonb NOT NULL DEFAULT '[]', created_by uuid,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('todo_template');

-- Rule packs per tenant (D54): the shipped pack is installed as approved on first use; uploads start as drafts.
CREATE TABLE rule_pack (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  pack_id text NOT NULL, pack_version text NOT NULL, status text NOT NULL CHECK (status IN ('draft','approved','superseded','rejected')),
  pack jsonb NOT NULL, notes text, uploaded_by uuid, approved_by uuid, approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, pack_id, pack_version)
);
ALTER TABLE rule_pack ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rule_pack USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE UNIQUE INDEX rule_pack_one_active ON rule_pack (tenant_id) WHERE status = 'approved';

CREATE TABLE rule_extension (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  rule_id text NOT NULL, period_key text NOT NULL, new_due_date date NOT NULL, scope jsonb NOT NULL DEFAULT '{}',
  notification text, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), approved_by uuid, approved_at timestamptz, tasks_moved int
);
ALTER TABLE rule_extension ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rule_extension USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON rule_extension (tenant_id, rule_id, period_key);

GRANT SELECT, INSERT, UPDATE ON service_type, client_service, task, task_bulk_undo, todo, todo_template, rule_pack, rule_extension TO worko_app;
