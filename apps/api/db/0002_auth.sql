-- Runtime role used for every request transaction (SET LOCAL ROLE worko_app). Not a superuser,
-- so RLS always applies. In production the API's login role is a member of worko_app.
-- Roles are cluster-wide: databases migrating concurrently (parallel test files, several environments on one
-- cluster) race between the existence check and CREATE, so tolerate the loser's duplicate error.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worko_app') THEN CREATE ROLE worko_app NOLOGIN; END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$;

ALTER TABLE tenant ADD COLUMN slug text UNIQUE;
UPDATE tenant SET slug = id::text WHERE slug IS NULL;
ALTER TABLE tenant ALTER COLUMN slug SET NOT NULL;

ALTER TABLE app_user
  ADD COLUMN failed_logins int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX app_user_phone ON app_user (tenant_id, phone) WHERE phone IS NOT NULL;

ALTER TABLE device_session ADD COLUMN ip inet, ADD COLUMN user_agent text;

-- Every refresh token ever issued; presenting a rotated one revokes the whole family (reuse detection).
CREATE TABLE refresh_token (
  hash text PRIMARY KEY, tenant_id uuid NOT NULL, session_id uuid NOT NULL REFERENCES device_session(id),
  rotated_at timestamptz, expires_at timestamptz NOT NULL
);
ALTER TABLE refresh_token ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refresh_token USING (tenant_id = current_tenant());

CREATE TABLE otp_challenge (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES app_user(id),
  code_hash text NOT NULL, purpose text NOT NULL, attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL, consumed_at timestamptz
);
ALTER TABLE otp_challenge ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON otp_challenge USING (tenant_id = current_tenant());

-- user_role / device_session were missing WITH CHECK in 0001: make inserts tenant-checked too.
ALTER POLICY tenant_isolation ON user_role USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
ALTER POLICY tenant_isolation ON device_session USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

GRANT SELECT ON tenant TO worko_app;
GRANT SELECT, INSERT, UPDATE ON firm_entity, branch, app_user, role, user_role, device_session, refresh_token, otp_challenge, idempotency_key TO worko_app;
GRANT DELETE ON user_role TO worko_app;
-- Audit log: append-only for the app.
GRANT SELECT, INSERT ON audit_log TO worko_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO worko_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO worko_app;
