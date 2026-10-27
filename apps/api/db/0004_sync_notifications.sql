-- Phase 2: teams, server-side sync, notifications, job queue.

-- Sync cursors must be visible in commit order, or a client can pull past a row that commits later with a
-- lower cursor and never see it. Serialise cursor assignment per tenant until commit (xact advisory lock).
CREATE OR REPLACE FUNCTION bump_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sync:' || NEW.tenant_id::text));
  NEW.version := COALESCE(OLD.version, 0) + 1;
  NEW.updated_at := now();
  NEW.sync_cursor := nextval('sync_cursor_seq');
  RETURN NEW;
END $$;

-- ---------- Teams ----------
CREATE TABLE team (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL, branch_id uuid REFERENCES branch(id), lead_user_id uuid REFERENCES app_user(id),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('team');
CREATE TABLE team_member (
  tenant_id uuid NOT NULL, team_id uuid NOT NULL REFERENCES team(id), user_id uuid NOT NULL REFERENCES app_user(id),
  PRIMARY KEY (team_id, user_id)
);
ALTER TABLE team_member ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON team_member USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON team_member (user_id);

-- ---------- Sync ----------
CREATE TABLE sync_mutation (           -- idempotency for /sync/push
  tenant_id uuid NOT NULL, key text NOT NULL, user_id uuid NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, key)
);
ALTER TABLE sync_mutation ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_mutation USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE sync_conflict (            -- losing values of same-field concurrent edits, reviewable/restorable
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, table_name text NOT NULL, row_id uuid NOT NULL, field text NOT NULL,
  lost jsonb, kept jsonb, mutation_key text NOT NULL, user_id uuid, device_id text,
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
ALTER TABLE sync_conflict ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_conflict USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON sync_conflict (tenant_id, user_id) WHERE resolved_at IS NULL;

-- ---------- Notifications ----------
CREATE TABLE notification (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  category text NOT NULL, priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  title text NOT NULL, body text NOT NULL DEFAULT '', entity_type text, entity_id uuid,
  fire_at timestamptz NOT NULL DEFAULT now(),       -- future = scheduled reminder (fires locally offline too)
  read_at timestamptz, acked_at timestamptz, snoozed_until timestamptz,
  requires_ack boolean NOT NULL DEFAULT false, escalate_after_minutes int, escalation_level int NOT NULL DEFAULT 0,
  escalated_from uuid REFERENCES notification(id), dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('notification');
CREATE UNIQUE INDEX notification_dedupe ON notification (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notification_inbox ON notification (tenant_id, user_id, fire_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE notification_pref (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  prefs jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, user_id)
);
CALL make_tenant_table('notification_pref');

CREATE TABLE push_subscription (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES app_user(id),
  session_id uuid REFERENCES device_session(id), kind text NOT NULL CHECK (kind IN ('fcm','webpush')),
  endpoint text NOT NULL, keys jsonb, created_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz, last_error text,
  UNIQUE (tenant_id, endpoint)
);
ALTER TABLE push_subscription ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON push_subscription USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE notification_delivery (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, notification_id uuid NOT NULL REFERENCES notification(id),
  subscription_id uuid REFERENCES push_subscription(id),
  channel text NOT NULL CHECK (channel IN ('fcm','webpush','email','whatsapp','sms')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts int NOT NULL DEFAULT 0, last_error text, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE notification_delivery ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_delivery USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE UNIQUE INDEX notification_delivery_once ON notification_delivery (notification_id, subscription_id);

-- ---------- Job queue ----------
-- Global (cross-tenant) pointer table claimed by workers with SKIP LOCKED. Holds ids only, never content.
-- The app role may only INSERT; workers run as the owner, then do the actual work inside tenantTx.
CREATE TABLE job_queue (
  id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, kind text NOT NULL, ref_id uuid NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(), attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 6,
  locked_until timestamptz, last_error text, dead_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_queue_ready ON job_queue (run_at) WHERE dead_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON team, team_member, sync_mutation, sync_conflict, notification, notification_pref,
  push_subscription, notification_delivery TO worko_app;
GRANT DELETE ON team_member TO worko_app;
GRANT INSERT ON job_queue TO worko_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO worko_app;
