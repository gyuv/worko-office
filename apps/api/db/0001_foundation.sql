-- Worko foundation schema. Tenant isolation via Postgres RLS keyed on `app.tenant_id`,
-- set per transaction by the API: SET LOCAL app.tenant_id = '<uuid>'.
-- Every syncable table carries: id (UUIDv7, app-generated), tenant_id, version, updated_at,
-- deleted_at (tombstone), updated_by, device_id, sync_cursor.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SEQUENCE sync_cursor_seq;

CREATE TABLE tenant (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'trial',
  seat_limit int,
  feature_flags jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION current_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Applies sync columns, bump trigger and RLS to a tenant table.
CREATE FUNCTION bump_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := COALESCE(OLD.version, 0) + 1;
  NEW.updated_at := now();
  NEW.sync_cursor := nextval('sync_cursor_seq');
  RETURN NEW;
END $$;

CREATE PROCEDURE make_tenant_table(t regclass) LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  EXECUTE format('CREATE TRIGGER %s_sync BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION bump_sync()', replace(t::text, '.', '_'), t);
  EXECUTE format('CREATE INDEX ON %s (tenant_id, sync_cursor)', t);
END $$;

CREATE TABLE firm_entity (            -- multiple billing registrations per firm ("Firmwise")
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL, frn text, pan text, gstin text, state_code char(2) NOT NULL,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('firm_entity');

CREATE TABLE branch (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL, state_code char(2), geofence jsonb,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('branch');

CREATE TABLE app_user (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  email text NOT NULL, phone text, name text NOT NULL,
  password_hash text, totp_secret_enc bytea, kind text NOT NULL DEFAULT 'staff' CHECK (kind IN ('staff','client','freelancer')),
  branch_id uuid REFERENCES branch(id), manager_id uuid REFERENCES app_user(id),
  status text NOT NULL DEFAULT 'active',
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, email)
);
CALL make_tenant_table('app_user');

CREATE TABLE role (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  key text NOT NULL, name text NOT NULL, system boolean NOT NULL DEFAULT false,
  grants jsonb NOT NULL, hidden_fields text[] NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, key)
);
CALL make_tenant_table('role');

CREATE TABLE user_role (tenant_id uuid NOT NULL, user_id uuid REFERENCES app_user(id), role_id uuid REFERENCES role(id), PRIMARY KEY (user_id, role_id));
ALTER TABLE user_role ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_role USING (tenant_id = current_tenant());

CREATE TABLE device_session (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES app_user(id),
  platform text NOT NULL CHECK (platform IN ('web','desktop','android')), label text,
  refresh_token_hash text NOT NULL, refresh_family uuid NOT NULL,
  last_seen_at timestamptz, revoked_at timestamptz, wipe_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE device_session ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_session USING (tenant_id = current_tenant());

-- Append-only, hash-chained audit log. UPDATE/DELETE are revoked from the app role.
CREATE TABLE audit_log (
  seq bigserial PRIMARY KEY, tenant_id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid, device_id text, action text NOT NULL, entity text NOT NULL, entity_id uuid,
  diff jsonb, ip inet, prev_hash bytea, hash bytea NOT NULL
);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_log FOR SELECT USING (tenant_id = current_tenant());
CREATE POLICY tenant_insert ON audit_log FOR INSERT WITH CHECK (tenant_id = current_tenant());

CREATE TABLE idempotency_key (
  tenant_id uuid NOT NULL, key text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
