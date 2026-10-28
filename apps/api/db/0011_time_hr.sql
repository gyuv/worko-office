-- Phase 6: time, costing, capacity (M10) + HR: attendance, leave, comp-off, expenses/advances (M14).
-- Money = bigint paise; dates are IST calendar dates; leave days in halves (numeric(5,1)).

-- Planned load for the capacity heat map.
ALTER TABLE task ADD COLUMN estimate_minutes int CHECK (estimate_minutes IS NULL OR estimate_minutes BETWEEN 0 AND 100000);

-- Firm HR settings (attendance policy, work week, timer cap, comp-off thresholds): one validated jsonb per tenant.
CREATE TABLE hr_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id), settings jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
ALTER TABLE hr_settings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON hr_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Per-user weekly capacity (NULL row → firm default).
CREATE TABLE hr_profile (
  tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid PRIMARY KEY REFERENCES app_user(id),
  weekly_capacity_minutes int NOT NULL CHECK (weekly_capacity_minutes BETWEEN 0 AND 10080),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
ALTER TABLE hr_profile ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON hr_profile USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Hourly cost per user with effective dates (sensitive: never synced, REST only behind canSeeCost).
CREATE TABLE cost_rate (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  hourly_paise bigint NOT NULL CHECK (hourly_paise >= 0), effective_from date NOT NULL, effective_to date, notes text, created_by uuid,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('cost_rate');
CREATE UNIQUE INDEX cost_rate_once ON cost_rate (tenant_id, user_id, effective_from) WHERE deleted_at IS NULL;

-- Firm holiday calendar (branch_id NULL = every branch).
CREATE TABLE holiday (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), on_date date NOT NULL, name text NOT NULL,
  branch_id uuid REFERENCES branch(id), optional boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('holiday');
CREATE UNIQUE INDEX holiday_once ON holiday (tenant_id, on_date, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE deleted_at IS NULL;

-- Office geofences per branch.
CREATE TABLE office_location (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), branch_id uuid REFERENCES branch(id), name text NOT NULL,
  lat numeric(9,6) NOT NULL CHECK (lat BETWEEN -90 AND 90), lng numeric(9,6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
  radius_m int NOT NULL CHECK (radius_m BETWEEN 10 AND 5000), active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('office_location');

-- Time entries (synced; devices create/edit their own drafts). Reversals carry negative minutes.
CREATE TABLE time_entry (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  task_id uuid REFERENCES task(id), client_id uuid REFERENCES client(id),
  work_date date NOT NULL, minutes int NOT NULL CHECK (minutes <> 0 AND minutes BETWEEN -1440 AND 1440),
  billable boolean NOT NULL DEFAULT true, notes text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('timer','manual','reversal')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  started_at timestamptz, ended_at timestamptz, capped boolean NOT NULL DEFAULT false,
  reverses_id uuid REFERENCES time_entry(id),
  submitted_at timestamptz, decided_by uuid, decided_at timestamptz, decision_note text, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  CHECK ((minutes < 0) = (reverses_id IS NOT NULL)),
  CHECK ((source = 'reversal') = (reverses_id IS NOT NULL))
);
CALL make_tenant_table('time_entry');
CREATE INDEX ON time_entry (tenant_id, user_id, work_date) WHERE deleted_at IS NULL;
CREATE INDEX ON time_entry (task_id);
CREATE INDEX ON time_entry (client_id);
CREATE UNIQUE INDEX time_entry_reversed_once ON time_entry (reverses_id) WHERE reverses_id IS NOT NULL AND deleted_at IS NULL;

-- Approved entries are immutable (corrections = reversal + new entry), enforced here, not only in code.
CREATE FUNCTION time_entry_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN RAISE EXCEPTION 'approved time entries are immutable' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'approved' AND (ROW(NEW.user_id, NEW.task_id, NEW.client_id, NEW.work_date, NEW.minutes, NEW.billable, NEW.notes, NEW.status, NEW.deleted_at, NEW.reverses_id)
      IS DISTINCT FROM ROW(OLD.user_id, OLD.task_id, OLD.client_id, OLD.work_date, OLD.minutes, OLD.billable, OLD.notes, OLD.status, OLD.deleted_at, OLD.reverses_id)) THEN
    RAISE EXCEPTION 'approved time entries are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER time_entry_lock BEFORE UPDATE OR DELETE ON time_entry FOR EACH ROW EXECUTE FUNCTION time_entry_lock();

-- Running timers: at most one per user (unique partial index). Stopped timers are soft-deleted (tombstone to devices).
CREATE TABLE time_timer (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  task_id uuid REFERENCES task(id), client_id uuid REFERENCES client(id), notes text, billable boolean NOT NULL DEFAULT true,
  started_at timestamptz NOT NULL, device_started_at timestamptz, stopped_at timestamptz, entry_id uuid REFERENCES time_entry(id),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('time_timer');
CREATE UNIQUE INDEX time_timer_one_running ON time_timer (tenant_id, user_id) WHERE stopped_at IS NULL AND deleted_at IS NULL;

-- Attendance: one row per user per IST day. Server times are authoritative; device-claimed times kept for skew checks.
-- Coordinates are rounded (4 dp) and only the check-in/out points are stored (D88).
CREATE TABLE attendance (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  work_date date NOT NULL, check_in_at timestamptz NOT NULL, check_out_at timestamptz,
  device_check_in_at timestamptz, device_check_out_at timestamptz,
  in_lat numeric(8,4), in_lng numeric(8,4), out_lat numeric(8,4), out_lng numeric(8,4),
  location_id uuid REFERENCES office_location(id), distance_m int, in_fence boolean, ip_ok boolean,
  method text NOT NULL DEFAULT 'online' CHECK (method IN ('online','offline','regularised')),
  flags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','flagged','needs_approval','approved','rejected')),
  minutes int, notes text, decided_by uuid, decided_at timestamptz,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  CHECK (check_out_at IS NULL OR check_out_at >= check_in_at)
);
CALL make_tenant_table('attendance');
CREATE UNIQUE INDEX attendance_one_per_day ON attendance (tenant_id, user_id, work_date) WHERE deleted_at IS NULL;

CREATE TABLE attendance_regularisation (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  work_date date NOT NULL, check_in_at timestamptz NOT NULL, check_out_at timestamptz, reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by uuid, decided_at timestamptz, decision_note text, attendance_id uuid REFERENCES attendance(id), created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  CHECK (check_out_at IS NULL OR check_out_at >= check_in_at)
);
CALL make_tenant_table('attendance_regularisation');
CREATE UNIQUE INDEX attendance_reg_pending ON attendance_regularisation (tenant_id, user_id, work_date) WHERE status = 'pending' AND deleted_at IS NULL;

-- Leave types are data (applicability by role key, accrual, carry-forward cap, half days).
CREATE TABLE leave_type (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), key text NOT NULL CHECK (key ~ '^[a-z0-9_]{2,40}$'), name text NOT NULL,
  paid boolean NOT NULL DEFAULT true, tracked boolean NOT NULL DEFAULT true, applies_to_roles text[] NOT NULL DEFAULT '{}',
  accrual jsonb NOT NULL DEFAULT '{"kind":"none","days":0}', carry_forward_cap numeric(5,1), allow_half_day boolean NOT NULL DEFAULT true,
  max_days_per_request numeric(5,1), comp_off boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true, sort int NOT NULL DEFAULT 0, notes text,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('leave_type');
CREATE UNIQUE INDEX leave_type_key ON leave_type (tenant_id, key) WHERE deleted_at IS NULL;

-- Balances are a ledger (credits/debits with reasons), never a mutable total. Append-only for the app role.
CREATE TABLE leave_ledger (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  leave_type_id uuid NOT NULL REFERENCES leave_type(id), delta numeric(5,1) NOT NULL CHECK (delta <> 0),
  reason text NOT NULL CHECK (reason IN ('opening','accrual','grant','comp_off','leave','cancel','lapse','adjustment')),
  ref_key text, request_id uuid, on_date date NOT NULL, expires_on date, note text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('leave_ledger');
-- Idempotent credits (accrual per period, comp-off per worked day, lapse per FY).
CREATE UNIQUE INDEX leave_ledger_once ON leave_ledger (tenant_id, user_id, leave_type_id, ref_key) WHERE ref_key IS NOT NULL;
CREATE INDEX ON leave_ledger (tenant_id, user_id, leave_type_id);

CREATE TABLE leave_request (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  leave_type_id uuid NOT NULL REFERENCES leave_type(id), from_date date NOT NULL, to_date date NOT NULL,
  start_half boolean NOT NULL DEFAULT false, end_half boolean NOT NULL DEFAULT false, days numeric(5,1) NOT NULL CHECK (days > 0),
  reason text, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','partially_approved','rejected','cancelled')),
  approved_from date, approved_to date, approved_start_half boolean, approved_end_half boolean, approved_days numeric(5,1),
  decided_by uuid, decided_at timestamptz, decision_note text, cancelled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  CHECK (to_date >= from_date), CHECK (approved_to IS NULL OR approved_to >= approved_from)
);
CALL make_tenant_table('leave_request');
CREATE INDEX ON leave_request (tenant_id, user_id, from_date) WHERE deleted_at IS NULL;

-- Expenses: category policy limits are data; claims with lines (partial approval per line); advances with a ledger.
CREATE TABLE expense_category (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), key text NOT NULL CHECK (key ~ '^[a-z0-9_]{2,40}$'), name text NOT NULL,
  limit_paise bigint CHECK (limit_paise IS NULL OR limit_paise >= 0), limit_mode text NOT NULL DEFAULT 'warn' CHECK (limit_mode IN ('warn','block')),
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('expense_category');
CREATE UNIQUE INDEX expense_category_key ON expense_category (tenant_id, key) WHERE deleted_at IS NULL;

CREATE TABLE expense_claim (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id), title text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','partially_approved','rejected','paid')),
  claimed_paise bigint NOT NULL DEFAULT 0, approved_paise bigint, advance_settled_paise bigint NOT NULL DEFAULT 0, paid_paise bigint NOT NULL DEFAULT 0,
  submitted_at timestamptz, decided_by uuid, decided_at timestamptz, decision_note text, paid_at timestamptz, paid_by uuid, payout_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  CHECK (approved_paise IS NULL OR approved_paise <= claimed_paise)
);
CALL make_tenant_table('expense_claim');
CREATE INDEX ON expense_claim (tenant_id, user_id);

CREATE TABLE expense_line (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), claim_id uuid NOT NULL REFERENCES expense_claim(id),
  sort int NOT NULL DEFAULT 0, category_key text NOT NULL, spent_on date NOT NULL, description text NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0), approved_paise bigint CHECK (approved_paise IS NULL OR (approved_paise >= 0 AND approved_paise <= amount_paise)),
  client_id uuid REFERENCES client(id), billable boolean NOT NULL DEFAULT false, receipt_doc_id uuid REFERENCES document(id),
  policy_flag text, decision_note text,
  -- Billed to the client as a reimbursement line (once): cleared if a draft's lines are rewritten.
  invoice_line_id uuid UNIQUE REFERENCES invoice_line(id) ON DELETE SET NULL, linked_at timestamptz, linked_by uuid,
  CHECK (NOT billable OR client_id IS NOT NULL)
);
ALTER TABLE expense_line ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_line USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON expense_line (claim_id);
CREATE INDEX ON expense_line (client_id) WHERE billable;

CREATE TABLE expense_advance (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  purpose text NOT NULL, amount_paise bigint NOT NULL CHECK (amount_paise > 0), approved_paise bigint CHECK (approved_paise IS NULL OR (approved_paise > 0 AND approved_paise <= amount_paise)),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','paid','settled')),
  decided_by uuid, decided_at timestamptz, decision_note text, paid_at timestamptz, paid_by uuid, payout_ref text, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('expense_advance');

-- Advance balance ledger per user: +paid out, −settled against a claim. Append-only for the app role.
CREATE TABLE advance_ledger (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  advance_id uuid NOT NULL REFERENCES expense_advance(id), claim_id uuid REFERENCES expense_claim(id),
  delta_paise bigint NOT NULL CHECK (delta_paise <> 0), kind text NOT NULL CHECK (kind IN ('paid','settled','refund')),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE advance_ledger ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON advance_ledger USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON advance_ledger (tenant_id, user_id);

-- One live daily comp-off job per tenant.
CREATE UNIQUE INDEX job_queue_compoff_one ON job_queue (tenant_id, kind) WHERE kind = 'hr.compoff' AND dead_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON hr_settings, hr_profile, cost_rate, holiday, office_location, time_entry, time_timer, attendance, attendance_regularisation,
  leave_type, leave_request, expense_category, expense_claim, expense_line, expense_advance TO worko_app;
GRANT SELECT, INSERT ON leave_ledger, advance_ledger TO worko_app;
GRANT DELETE ON expense_line TO worko_app;
