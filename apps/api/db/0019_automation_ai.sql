-- Phase 10: automation (M15) and the AI layer (M21). REST-only (not synced to devices — D147); sync columns kept per convention.
-- Domain events are written to an outbox BY TRIGGER in the same transaction as the source change, so an event exists iff the
-- change commits; each event also gets a job (exactly-once per rule × event is enforced by automation_run's idempotency key).
-- Money = bigint paise. AI prompts/outputs/redaction maps are KeyService ciphertext only.

-- ---------- Settings (1 row per tenant, validated jsonb) ----------
CREATE TABLE automation_settings (tenant_id uuid PRIMARY KEY REFERENCES tenant(id), settings jsonb NOT NULL DEFAULT '{}', last_scan_day date,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid);
ALTER TABLE automation_settings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE ai_settings (tenant_id uuid PRIMARY KEY REFERENCES tenant(id), settings jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid);
ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
-- The Phase 8 per-firm notice-extraction opt-in moves here (D150).
INSERT INTO ai_settings (tenant_id, settings) SELECT tenant_id, jsonb_build_object('enabled', true, 'features', jsonb_build_object('notice_extraction', true))
  FROM practice_settings WHERE (settings->'ai'->>'noticeExtraction')::boolean IS TRUE;

-- ---------- Rules ----------
CREATE TABLE automation_rule (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), name text NOT NULL, description text,
  owner_id uuid NOT NULL REFERENCES app_user(id), scope text NOT NULL CHECK (scope IN ('firm','personal')),
  enabled boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')), paused_reason text, paused_at timestamptz,
  definition jsonb NOT NULL, trigger_kind text NOT NULL CHECK (trigger_kind IN ('event','schedule')), trigger_event text NOT NULL,
  listen_events text[] NOT NULL DEFAULT '{}', -- trigger + ladder stopOn: the outbox trigger only writes events some live rule listens to
  rule_version int NOT NULL DEFAULT 1, agent_key text, agent_params jsonb, consecutive_failures int NOT NULL DEFAULT 0,
  next_run_at timestamptz, last_run_at timestamptz, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('automation_rule');
CREATE INDEX automation_rule_live ON automation_rule USING gin (listen_events) WHERE enabled AND deleted_at IS NULL;

CREATE TABLE automation_rule_version (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), rule_id uuid NOT NULL REFERENCES automation_rule(id), rule_version int NOT NULL,
  name text NOT NULL, definition jsonb NOT NULL, changed_by uuid, changed_at timestamptz NOT NULL DEFAULT now(), note text,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  UNIQUE (rule_id, rule_version)
);
CALL make_tenant_table('automation_rule_version');

-- ---------- Outbox ----------
CREATE TABLE automation_event (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), type text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL, client_id uuid,
  payload jsonb NOT NULL DEFAULT '{}', causation jsonb, dedupe_key text, occurred_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('automation_event');
CREATE UNIQUE INDEX automation_event_dedupe ON automation_event (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX automation_event_recent ON automation_event (tenant_id, type, occurred_at DESC);
CREATE INDEX ON automation_event (entity_id);

CREATE TABLE automation_run (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), rule_id uuid NOT NULL REFERENCES automation_rule(id), rule_version int NOT NULL,
  event_id uuid REFERENCES automation_event(id), subject_key text, step text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed','skipped','no_match')), skip_reason text,
  idempotency_key text NOT NULL, depth int NOT NULL DEFAULT 0, causation jsonb, actions_total int NOT NULL DEFAULT 0, actions_done int NOT NULL DEFAULT 0,
  cost_paise bigint NOT NULL DEFAULT 0, error text, detail jsonb NOT NULL DEFAULT '{}', -- condition trace (field/op/ok only — never values)
  attempts int NOT NULL DEFAULT 1, started_at timestamptz NOT NULL, finished_at timestamptz,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('automation_run');
CREATE UNIQUE INDEX automation_run_once ON automation_run (tenant_id, idempotency_key);
CREATE INDEX ON automation_run (rule_id, started_at DESC);

CREATE TABLE automation_run_action (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), run_id uuid NOT NULL REFERENCES automation_run(id), idx int NOT NULL, type text NOT NULL,
  status text NOT NULL CHECK (status IN ('done','queued','refused','failed','skipped','rate_limited')), code text, result jsonb NOT NULL DEFAULT '{}',
  cost_paise bigint NOT NULL DEFAULT 0, error text, attempts int NOT NULL DEFAULT 1, finished_at timestamptz NOT NULL,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  UNIQUE (run_id, idx)
);
CALL make_tenant_table('automation_run_action');

-- Per rule × subject state for time-based rules (ladder steps, stop reason).
CREATE TABLE automation_subject (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), rule_id uuid NOT NULL REFERENCES automation_rule(id), subject_key text NOT NULL,
  entity_type text NOT NULL, entity_id uuid NOT NULL, client_id uuid, steps int NOT NULL DEFAULT 0, last_step_day date, escalated boolean NOT NULL DEFAULT false,
  stopped_at timestamptz, stop_reason text, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  UNIQUE (rule_id, subject_key)
);
CALL make_tenant_table('automation_subject');
CREATE INDEX ON automation_subject (rule_id, client_id) WHERE stopped_at IS NULL;

-- ---------- Suggestions (AI outputs + automation actions that need a human) ----------
CREATE TABLE suggestion (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('draft_reply','summary','classification','draft_message','esign_request')), feature text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','failed')),
  client_id uuid REFERENCES client(id), entity_type text, entity_id uuid, requested_by uuid, rule_id uuid REFERENCES automation_rule(id), run_id uuid,
  provider text, model text,
  payload_enc bytea,  -- the suggestion itself (restored text etc.) — KeyService, AAD suggestion:<id>:payload
  prompt_enc bytea,   -- exactly what was sent (redacted) — KeyService, AAD suggestion:<id>:prompt
  map_enc bytea,      -- redaction placeholder → original; never sent anywhere — KeyService, AAD suggestion:<id>:map
  sources jsonb NOT NULL DEFAULT '[]', -- ids + labels only; snippets live inside payload_enc
  meta jsonb NOT NULL DEFAULT '{}',    -- non-PII metadata (channel, field names, tokens)
  decided_by uuid, decided_at timestamptz, applied jsonb, error text, purge_after timestamptz, purged_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('suggestion');
CREATE INDEX suggestion_pending ON suggestion (tenant_id, status, created_at DESC);
CREATE INDEX ON suggestion (client_id);

-- ---------- AI metering ----------
CREATE TABLE ai_rate (
  provider text NOT NULL, model text NOT NULL, input_paise_per_mtok bigint NOT NULL CHECK (input_paise_per_mtok >= 0), output_paise_per_mtok bigint NOT NULL CHECK (output_paise_per_mtok >= 0),
  effective_from date NOT NULL, verified boolean NOT NULL DEFAULT false, note text, PRIMARY KEY (provider, model, effective_from)
);
-- VERIFY AGAINST OFFICIAL DOCS: provider pricing (USD per million tokens) and the INR conversion. Indicative, unverified placeholders.
INSERT INTO ai_rate (provider, model, input_paise_per_mtok, output_paise_per_mtok, effective_from, note) VALUES
  ('mock', '*', 0, 0, '2026-01-01', 'deterministic mock: no charge'),
  ('anthropic', '*', 150000, 750000, '2026-01-01', 'indicative ₹1,500 / ₹7,500 per million input/output tokens, unverified');

CREATE TABLE ai_usage (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), feature text NOT NULL, user_id uuid, rule_id uuid, suggestion_id uuid,
  provider text NOT NULL, model text NOT NULL, input_tokens int NOT NULL DEFAULT 0, output_tokens int NOT NULL DEFAULT 0, cost_paise bigint NOT NULL DEFAULT 0,
  month text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'), occurred_at timestamptz NOT NULL,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('ai_usage');
CREATE INDEX ON ai_usage (tenant_id, month);
CREATE INDEX ON ai_usage (rule_id, month) WHERE rule_id IS NOT NULL;

-- ---------- Outbox triggers ----------
-- Writes an event only when some enabled rule listens to it (no outbox noise for firms without automation).
-- Causation comes from the automation runner (app.causation, set per transaction) so loops can be cut (D144).
CREATE FUNCTION automation_emit(p_tenant uuid, p_type text, p_entity text, p_id uuid, p_client uuid, p_payload jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE eid uuid := gen_random_uuid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM automation_rule WHERE tenant_id = p_tenant AND enabled AND status = 'active' AND deleted_at IS NULL AND p_type = ANY (listen_events)) THEN RETURN; END IF;
  INSERT INTO automation_event (id, tenant_id, type, entity_type, entity_id, client_id, payload, causation)
    VALUES (eid, p_tenant, p_type, p_entity, p_id, p_client, p_payload, NULLIF(current_setting('app.causation', true), '')::jsonb);
  -- run_at epoch: due immediately for any queue clock (tests pin theirs).
  INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) VALUES (p_tenant, 'automation.event', eid, 'epoch');
END $$;

CREATE FUNCTION automation_task_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN PERFORM automation_emit(NEW.tenant_id, 'task.created', 'task', NEW.id, NEW.client_id, jsonb_build_object('status', NEW.status));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN PERFORM automation_emit(NEW.tenant_id, 'task.status_changed', 'task', NEW.id, NEW.client_id, jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER task_automation AFTER INSERT OR UPDATE OF status ON task FOR EACH ROW EXECUTE FUNCTION automation_task_trg();

CREATE FUNCTION automation_invoice_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'invoice' AND OLD.status = 'draft' AND NEW.status = 'issued' THEN
    PERFORM automation_emit(NEW.tenant_id, 'invoice.issued', 'invoice', NEW.id, NEW.client_id, jsonb_build_object('totalPaise', NEW.total_paise));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER invoice_automation AFTER UPDATE OF status ON invoice FOR EACH ROW EXECUTE FUNCTION automation_invoice_trg();

CREATE FUNCTION automation_insert_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'receipt' THEN PERFORM automation_emit(NEW.tenant_id, 'receipt.recorded', 'receipt', NEW.id, NEW.client_id, jsonb_build_object('amountPaise', NEW.amount_paise));
  ELSIF TG_TABLE_NAME = 'document' THEN
    IF NEW.client_id IS NOT NULL AND NEW.deleted_at IS NULL THEN PERFORM automation_emit(NEW.tenant_id, 'document.uploaded', 'document', NEW.id, NEW.client_id, jsonb_build_object('source', NEW.source)); END IF;
  ELSIF TG_TABLE_NAME = 'notice' THEN PERFORM automation_emit(NEW.tenant_id, 'notice.received', 'notice', NEW.id, NEW.client_id, '{}');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER receipt_automation AFTER INSERT ON receipt FOR EACH ROW EXECUTE FUNCTION automation_insert_trg();
CREATE TRIGGER document_automation AFTER INSERT ON document FOR EACH ROW EXECUTE FUNCTION automation_insert_trg();
CREATE TRIGGER notice_automation AFTER INSERT ON notice FOR EACH ROW EXECUTE FUNCTION automation_insert_trg();

CREATE FUNCTION automation_crm_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'lead' THEN
    IF NEW.stage IS DISTINCT FROM OLD.stage THEN PERFORM automation_emit(NEW.tenant_id, 'lead.stage_changed', 'lead', NEW.id, NEW.client_id, jsonb_build_object('from', OLD.stage, 'to', NEW.stage)); END IF;
  ELSE
    IF NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted' THEN PERFORM automation_emit(NEW.tenant_id, 'proposal.accepted', 'proposal', NEW.id, NULL, '{}'); END IF;
    IF NEW.conversion IS NOT NULL AND OLD.conversion IS NULL THEN
      PERFORM automation_emit(NEW.tenant_id, 'proposal.converted', 'proposal', NEW.id, NULLIF(NEW.conversion->>'clientId', '')::uuid, '{}');
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER lead_automation AFTER UPDATE OF stage ON lead FOR EACH ROW EXECUTE FUNCTION automation_crm_trg();
CREATE TRIGGER proposal_automation AFTER UPDATE ON proposal FOR EACH ROW EXECUTE FUNCTION automation_crm_trg();

-- One live tick job per tenant (scan + schedules + retention).
CREATE UNIQUE INDEX job_queue_automation_tick_one ON job_queue (tenant_id, kind) WHERE kind = 'automation.tick' AND dead_at IS NULL;

-- New module 'ai' (D148): give existing firms' system roles the same grants a new firm gets.
UPDATE role SET grants = grants || (SELECT jsonb_agg(jsonb_build_object('module', 'ai', 'action', a, 'scope', 'all')) FROM unnest(ARRAY['view','create','edit','delete','approve','export','print','assign','reveal']) a)
  WHERE system AND key = 'partner';
UPDATE role SET grants = grants || (SELECT jsonb_agg(jsonb_build_object('module', 'ai', 'action', a, 'scope', 'team')) FROM unnest(ARRAY['view','create','edit','assign','approve','export','print']) a)
  WHERE system AND key = 'manager';
UPDATE role SET grants = grants || (SELECT jsonb_agg(jsonb_build_object('module', 'ai', 'action', a, 'scope', 'all')) FROM unnest(ARRAY['view','export']) a)
  WHERE system AND key = 'auditor';

GRANT SELECT, INSERT, UPDATE ON automation_settings, ai_settings, automation_rule, automation_event, automation_run, automation_run_action, automation_subject, suggestion TO worko_app;
GRANT SELECT, INSERT ON automation_rule_version, ai_usage TO worko_app;
GRANT DELETE ON automation_event TO worko_app; -- retention of processed events
GRANT SELECT ON ai_rate TO worko_app;
