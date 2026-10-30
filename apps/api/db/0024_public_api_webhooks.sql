-- Phase 12 B (M18): public API keys + outbound webhooks (D190–D199).

-- ---------- API keys ----------
-- Global prefix → tenant directory (the guard must find the tenant before it can open a tenant transaction).
-- Owner-only (systemTx); holds no secret material.
CREATE TABLE api_key_lookup (prefix text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE api_key (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), name text NOT NULL,
  prefix text NOT NULL UNIQUE, secret_hash bytea NOT NULL,           -- SHA-256 of the secret part; the key is shown once
  scopes text[] NOT NULL, client_group_ids uuid[],                   -- NULL = no client-group restriction
  ip_allowlist text[] NOT NULL DEFAULT '{}', rate_per_min int NOT NULL DEFAULT 120 CHECK (rate_per_min BETWEEN 1 AND 2000),
  expires_at timestamptz, created_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz, revoked_at timestamptz, revoked_by uuid, last_used_at timestamptz, last_used_ip inet,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('api_key');
CREATE INDEX ON api_key (created_by);

-- ---------- Webhooks ----------
CREATE TABLE webhook_subscription (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), name text NOT NULL, url text NOT NULL CHECK (url LIKE 'https://%'),
  events text[] NOT NULL, secret_enc bytea NOT NULL,                  -- KeyService, AAD webhook_subscription:<id>:secret
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')), disabled_reason text, consecutive_failures int NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(), last_delivery_at timestamptz,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('webhook_subscription');
CREATE INDEX webhook_subscription_events ON webhook_subscription USING gin (events) WHERE status = 'active' AND deleted_at IS NULL;

-- Delivery log: envelope holds ids only (no names/amounts/contacts); errors are short codes, never response bodies.
CREATE TABLE webhook_delivery (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), subscription_id uuid NOT NULL REFERENCES webhook_subscription(id),
  event_id uuid, event_type text NOT NULL, envelope jsonb NOT NULL, redelivery_of uuid REFERENCES webhook_delivery(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','retrying','succeeded','failed','skipped')),
  attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz, last_status_code int, last_error text, last_duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('webhook_delivery');
CREATE INDEX ON webhook_delivery (subscription_id, created_at DESC);

-- ---------- Outbox: also emit when a webhook subscription listens ----------
CREATE OR REPLACE FUNCTION automation_emit(p_tenant uuid, p_type text, p_entity text, p_id uuid, p_client uuid, p_payload jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE eid uuid := gen_random_uuid(); hooks boolean;
BEGIN
  hooks := EXISTS (SELECT 1 FROM webhook_subscription WHERE tenant_id = p_tenant AND status = 'active' AND deleted_at IS NULL AND events @> ARRAY[p_type]);
  IF NOT hooks AND NOT EXISTS (SELECT 1 FROM automation_rule WHERE tenant_id = p_tenant AND enabled AND status = 'active' AND deleted_at IS NULL AND listen_events @> ARRAY[p_type]) THEN RETURN; END IF;
  INSERT INTO automation_event (id, tenant_id, type, entity_type, entity_id, client_id, payload, causation)
    VALUES (eid, p_tenant, p_type, p_entity, p_id, p_client, p_payload, NULLIF(current_setting('app.causation', true), '')::jsonb);
  INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) VALUES (p_tenant, 'automation.event', eid, 'epoch');
  IF hooks THEN INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) VALUES (p_tenant, 'webhook.fanout', eid, 'epoch'); END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON api_key, webhook_subscription, webhook_delivery TO worko_app;
GRANT DELETE ON idempotency_key TO worko_app; -- public-API Idempotency-Key reservations are released when the request fails
