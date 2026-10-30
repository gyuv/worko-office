-- Phase 10 review: idempotency keys for automation/approval side effects, action claims, suggestion claims + source fingerprints,
-- rule ownership history, outbox trigger fixes, legacy AI toggle cleared.

-- ---------- Idempotency keys (one row per key per tenant; services return the existing row on a repeat) ----------
ALTER TABLE comm_message ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX comm_message_idem ON comm_message (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE task ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX task_idem ON task (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE esign_request ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX esign_request_idem ON esign_request (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE invoice ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX invoice_idem ON invoice (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE pbc_item ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX pbc_item_idem ON pbc_item (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---------- Action claims: a row exists (running/retrying) before the side effect, so concurrent workers never both act ----------
ALTER TABLE automation_run_action DROP CONSTRAINT IF EXISTS automation_run_action_status_check;
ALTER TABLE automation_run_action ADD CONSTRAINT automation_run_action_status_check CHECK (status IN ('running','retrying','done','queued','refused','failed','skipped','rate_limited'));
ALTER TABLE automation_run ADD COLUMN subject_done boolean NOT NULL DEFAULT false;
CREATE INDEX automation_run_stale ON automation_run (tenant_id, started_at) WHERE status = 'running';

-- ---------- Suggestions: atomic claim while applying; fingerprint of the sources the model saw ----------
ALTER TABLE suggestion DROP CONSTRAINT IF EXISTS suggestion_status_check;
ALTER TABLE suggestion ADD CONSTRAINT suggestion_status_check CHECK (status IN ('pending','applying','approved','rejected','failed'));
ALTER TABLE suggestion ADD COLUMN source_fp jsonb NOT NULL DEFAULT '{}';

-- ---------- Rule ownership: whoever changes a definition becomes the owner (D153) ----------
ALTER TABLE automation_rule_version ADD COLUMN owner_id uuid, ADD COLUMN previous_owner_id uuid;
UPDATE automation_rule_version v SET owner_id = r.owner_id FROM automation_rule r WHERE r.id = v.rule_id;

-- ---------- Outbox: GIN-friendly predicate; invoices inserted already issued ----------
CREATE OR REPLACE FUNCTION automation_emit(p_tenant uuid, p_type text, p_entity text, p_id uuid, p_client uuid, p_payload jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE eid uuid := gen_random_uuid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM automation_rule WHERE tenant_id = p_tenant AND enabled AND status = 'active' AND deleted_at IS NULL AND listen_events @> ARRAY[p_type]) THEN RETURN; END IF;
  INSERT INTO automation_event (id, tenant_id, type, entity_type, entity_id, client_id, payload, causation)
    VALUES (eid, p_tenant, p_type, p_entity, p_id, p_client, p_payload, NULLIF(current_setting('app.causation', true), '')::jsonb);
  INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) VALUES (p_tenant, 'automation.event', eid, 'epoch');
END $$;
CREATE OR REPLACE FUNCTION automation_invoice_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'invoice' AND NEW.status = 'issued' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    PERFORM automation_emit(NEW.tenant_id, 'invoice.issued', 'invoice', NEW.id, NEW.client_id, jsonb_build_object('totalPaise', NEW.total_paise));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER invoice_automation_insert AFTER INSERT ON invoice FOR EACH ROW EXECUTE FUNCTION automation_invoice_trg();

-- ---------- Legacy AI toggle: the firm's ai_settings always win (D150 revised); clear the old flag ----------
UPDATE practice_settings SET settings = jsonb_set(settings, '{ai,noticeExtraction}', 'false') WHERE settings->'ai' ? 'noticeExtraction';
GRANT UPDATE ON ai_usage TO worko_app; -- reserved usage rows are settled after the call
