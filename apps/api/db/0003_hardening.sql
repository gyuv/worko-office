-- Phase 1 review fixes.
-- 1. idempotency_key was missing RLS: stored responses could leak across firms.
ALTER TABLE idempotency_key ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_key USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- 2. Device id is server-assigned at login and never taken from the client afterwards.
ALTER TABLE device_session ADD COLUMN device_id text;
UPDATE device_session SET device_id = id::text WHERE device_id IS NULL;
ALTER TABLE device_session ALTER COLUMN device_id SET NOT NULL;

-- 3. TOTP replay protection: last accepted 30-second time step.
ALTER TABLE app_user ADD COLUMN totp_last_step bigint;
