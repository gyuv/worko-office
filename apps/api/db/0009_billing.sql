-- Phase 5: billing & collections (M9) + Tally connector tables (M18). Money = bigint paise. Prices are data (billing_rate).

-- Firm billing entities: firm_entity (0001) gains address, bank details, invoice series prefix, logo.
ALTER TABLE firm_entity
  ADD COLUMN address text, ADD COLUMN email text, ADD COLUMN phone text,
  ADD COLUMN bank jsonb NOT NULL DEFAULT '{}',              -- { name, accountNo, ifsc, branch, upiId } printed on invoices
  ADD COLUMN invoice_prefix text NOT NULL DEFAULT 'INV' CHECK (invoice_prefix ~ '^[A-Z0-9]{1,4}$'),
  ADD COLUMN logo_doc_id uuid REFERENCES document(id),
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN field_versions jsonb NOT NULL DEFAULT '{}',
  ADD CONSTRAINT firm_entity_state CHECK (state_code ~ '^\d{2}$');

-- SAC + GST rate per service (data; NULL → billing_settings defaults).
ALTER TABLE service_type ADD COLUMN sac_code text CHECK (sac_code ~ '^\d{4,8}$'), ADD COLUMN gst_rate numeric(5,2) CHECK (gst_rate >= 0 AND gst_rate <= 28);
-- Retainers: a subscription with a billing frequency is billed per period from the rate table.
ALTER TABLE client_service ADD COLUMN billing_frequency text CHECK (billing_frequency IN ('monthly','quarterly','annual'));

-- One row per tenant: defaults, follow-up ladder (data), terms.
CREATE TABLE billing_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  default_entity_id uuid REFERENCES firm_entity(id), due_days int NOT NULL DEFAULT 15 CHECK (due_days BETWEEN 0 AND 365),
  default_gst_rate numeric(5,2) NOT NULL DEFAULT 18, default_sac text NOT NULL DEFAULT '998231',
  ladder jsonb NOT NULL DEFAULT '[]', terms text, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
ALTER TABLE billing_settings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Gap-free numbering per entity × series × FY (row lock serialises concurrent issues; rollback keeps no gap).
CREATE TABLE billing_counter (
  tenant_id uuid NOT NULL, entity_id uuid NOT NULL REFERENCES firm_entity(id), series text NOT NULL CHECK (series IN ('invoice','credit_note','debit_note','receipt')),
  fy int NOT NULL, next int NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id, entity_id, series, fy)
);
ALTER TABLE billing_counter ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_counter USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE billing_rate (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  service_type_id uuid NOT NULL REFERENCES service_type(id), client_id uuid REFERENCES client(id), group_id uuid REFERENCES client_group(id),
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0), effective_from date NOT NULL, effective_to date,
  notes text, created_by uuid,
  CHECK (client_id IS NULL OR group_id IS NULL), CHECK (effective_to IS NULL OR effective_to >= effective_from),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('billing_rate');
CREATE INDEX ON billing_rate (tenant_id, service_type_id, effective_from) WHERE deleted_at IS NULL;

-- Invoices, credit notes and debit notes share one table (same header/tax shape; one balance formula).
CREATE TABLE invoice (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','credit_note','debit_note')),
  against_invoice_id uuid REFERENCES invoice(id),
  entity_id uuid NOT NULL REFERENCES firm_entity(id), client_id uuid NOT NULL REFERENCES client(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_paid','paid','cancelled')),
  number text, fy int, issue_date date, due_date date,
  supply_type text NOT NULL CHECK (supply_type IN ('intra','inter','unregistered')),
  supplier_state char(2) NOT NULL, place_of_supply char(2), supplier_gstin text, client_gstin text,
  bill_to jsonb NOT NULL DEFAULT '{}',                       -- snapshot: name, address, state at drafting/issue
  taxable_paise bigint NOT NULL DEFAULT 0, cgst_paise bigint NOT NULL DEFAULT 0, sgst_paise bigint NOT NULL DEFAULT 0, igst_paise bigint NOT NULL DEFAULT 0,
  reimbursement_paise bigint NOT NULL DEFAULT 0, round_off_paise bigint NOT NULL DEFAULT 0, total_paise bigint NOT NULL DEFAULT 0,
  -- Derived settlement (recomputed in the same transaction as any allocation/note).
  allocated_paise bigint NOT NULL DEFAULT 0, tds_paise bigint NOT NULL DEFAULT 0, credited_paise bigint NOT NULL DEFAULT 0, balance_paise bigint NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto','retainer')),
  client_service_id uuid REFERENCES client_service(id), period_key text,
  notes text, reason text, promise_to_pay date, followup_paused boolean NOT NULL DEFAULT false,
  issued_at timestamptz, issued_by uuid, cancelled_at timestamptz, cancelled_by uuid, cancel_reason text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK ((kind = 'invoice') = (against_invoice_id IS NULL)),
  CHECK (balance_paise >= 0)
);
CALL make_tenant_table('invoice');
CREATE UNIQUE INDEX invoice_number ON invoice (tenant_id, entity_id, kind, number) WHERE number IS NOT NULL;
CREATE INDEX ON invoice (client_id);
CREATE INDEX invoice_open ON invoice (tenant_id, due_date) WHERE deleted_at IS NULL AND status IN ('issued','partially_paid');
CREATE INDEX ON invoice (against_invoice_id);
-- One retainer draft/invoice per subscription × period (idempotent retainer runs).
CREATE UNIQUE INDEX invoice_retainer_once ON invoice (tenant_id, client_service_id, period_key)
  WHERE source = 'retainer' AND deleted_at IS NULL AND status <> 'cancelled';

CREATE TABLE invoice_line (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), invoice_id uuid NOT NULL REFERENCES invoice(id),
  sort int NOT NULL DEFAULT 0, description text NOT NULL, sac text, service_type_id uuid REFERENCES service_type(id),
  qty numeric(12,2) NOT NULL CHECK (qty > 0), rate_paise bigint NOT NULL CHECK (rate_paise >= 0), discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  gst_rate numeric(5,2) NOT NULL DEFAULT 0, reimbursement boolean NOT NULL DEFAULT false,
  amount_paise bigint NOT NULL, taxable_paise bigint NOT NULL, cgst_paise bigint NOT NULL, sgst_paise bigint NOT NULL, igst_paise bigint NOT NULL, total_paise bigint NOT NULL
);
ALTER TABLE invoice_line ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_line USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON invoice_line (invoice_id);

-- Tasks billed by an invoice line. `live` turns false when the draft is deleted or the invoice cancelled, so a task is on
-- at most one live (non-cancelled) invoice — enforced here, not only in code.
CREATE TABLE invoice_task (
  tenant_id uuid NOT NULL, invoice_id uuid NOT NULL REFERENCES invoice(id), line_id uuid NOT NULL REFERENCES invoice_line(id),
  task_id uuid NOT NULL REFERENCES task(id), live boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (line_id, task_id)
);
ALTER TABLE invoice_task ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_task USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE UNIQUE INDEX invoice_task_once ON invoice_task (task_id) WHERE live;
CREATE INDEX ON invoice_task (invoice_id);

-- Issued documents are immutable: content columns and lines may change only while the header is a draft.
CREATE FUNCTION invoice_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
     NEW.kind, NEW.against_invoice_id, NEW.entity_id, NEW.client_id, NEW.number, NEW.fy, NEW.issue_date, NEW.supply_type, NEW.supplier_state,
     NEW.place_of_supply, NEW.supplier_gstin, NEW.client_gstin, NEW.bill_to, NEW.taxable_paise, NEW.cgst_paise, NEW.sgst_paise, NEW.igst_paise,
     NEW.reimbursement_paise, NEW.round_off_paise, NEW.total_paise, NEW.notes)
     IS DISTINCT FROM (
     OLD.kind, OLD.against_invoice_id, OLD.entity_id, OLD.client_id, OLD.number, OLD.fy, OLD.issue_date, OLD.supply_type, OLD.supplier_state,
     OLD.place_of_supply, OLD.supplier_gstin, OLD.client_gstin, OLD.bill_to, OLD.taxable_paise, OLD.cgst_paise, OLD.sgst_paise, OLD.igst_paise,
     OLD.reimbursement_paise, OLD.round_off_paise, OLD.total_paise, OLD.notes) THEN
    RAISE EXCEPTION 'invoice % is issued and immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    RAISE EXCEPTION 'issued invoice % cannot be deleted', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_lock BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION invoice_lock();
CREATE FUNCTION invoice_line_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM invoice WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  -- Credit/debit notes are born issued: their lines are inserted once, in the creating transaction, under a flag naming the note.
  IF TG_OP = 'INSERT' AND current_setting('worko.note_lines', true) = NEW.invoice_id::text THEN RETURN NEW; END IF;
  IF s IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'lines of a non-draft invoice are immutable' USING ERRCODE = 'check_violation'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER invoice_line_lock BEFORE INSERT OR UPDATE OR DELETE ON invoice_line FOR EACH ROW EXECUTE FUNCTION invoice_line_lock();

CREATE TABLE receipt (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES firm_entity(id), client_id uuid NOT NULL REFERENCES client(id),
  number text NOT NULL, fy int NOT NULL, received_on date NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0), tds_paise bigint NOT NULL DEFAULT 0 CHECK (tds_paise >= 0), tds_section text,
  mode text NOT NULL CHECK (mode IN ('cash','bank','upi','cheque','online')), reference text, notes text,
  allocated_paise bigint NOT NULL DEFAULT 0, unallocated_paise bigint NOT NULL DEFAULT 0 CHECK (unallocated_paise >= 0),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','gateway')), provider text, provider_payment_id text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  CHECK (amount_paise + tds_paise > 0)
);
CALL make_tenant_table('receipt');
CREATE UNIQUE INDEX receipt_number ON receipt (tenant_id, entity_id, number);
CREATE UNIQUE INDEX receipt_provider_payment ON receipt (tenant_id, provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX ON receipt (client_id);

CREATE TABLE receipt_allocation (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  receipt_id uuid NOT NULL REFERENCES receipt(id), invoice_id uuid NOT NULL REFERENCES invoice(id),
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0), tds_paise bigint NOT NULL DEFAULT 0 CHECK (tds_paise >= 0),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), CHECK (amount_paise + tds_paise > 0)
);
ALTER TABLE receipt_allocation ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON receipt_allocation USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON receipt_allocation (invoice_id);
CREATE INDEX ON receipt_allocation (receipt_id);

-- Every reminder/message about an invoice. Follow-ups are idempotent per invoice × step × channel.
CREATE TABLE billing_message (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), invoice_id uuid NOT NULL REFERENCES invoice(id),
  kind text NOT NULL CHECK (kind IN ('send','followup','escalation')), step int, channel text NOT NULL CHECK (channel IN ('email','whatsapp','in_app')),
  recipient text, status text NOT NULL CHECK (status IN ('sent','failed','skipped')), detail text, provider_ref text,
  as_of date, created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE billing_message ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_message USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE UNIQUE INDEX billing_message_followup_once ON billing_message (invoice_id, step, channel) WHERE kind IN ('followup','escalation');
CREATE INDEX ON billing_message (invoice_id);

CREATE TABLE payment_link (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), invoice_id uuid NOT NULL REFERENCES invoice(id),
  provider text NOT NULL, provider_link_id text NOT NULL, url text NOT NULL, amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','expired','cancelled')),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz
);
ALTER TABLE payment_link ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_link USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE UNIQUE INDEX payment_link_provider ON payment_link (provider, provider_link_id);
CREATE INDEX ON payment_link (invoice_id);

-- Webhook replay protection: one row per provider event id.
CREATE TABLE payment_event (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), provider text NOT NULL, event_id text NOT NULL,
  event_type text NOT NULL, body_sha256 text NOT NULL, receipt_id uuid REFERENCES receipt(id), outcome text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, event_id)
);
ALTER TABLE payment_event ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_event USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Tally connector: our account key → Tally ledger name (per entity, or NULL = all entities); export log for idempotency.
CREATE TABLE tally_ledger_map (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), entity_id uuid REFERENCES firm_entity(id),
  account_key text NOT NULL CHECK (account_key ~ '^[a-z_]+(:[A-Za-z0-9_-]+)?$'), ledger_name text NOT NULL,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tally_ledger_map ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tally_ledger_map USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE UNIQUE INDEX tally_ledger_map_key ON tally_ledger_map (tenant_id, COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), account_key);

CREATE TABLE tally_export_log (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), batch_id uuid NOT NULL,
  voucher_kind text NOT NULL CHECK (voucher_kind IN ('invoice','receipt')), source_id uuid NOT NULL, voucher_number text NOT NULL,
  exported_by uuid, exported_at timestamptz NOT NULL DEFAULT now(), times int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, voucher_kind, source_id)
);
ALTER TABLE tally_export_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tally_export_log USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- One live daily follow-up job and one monthly retainer job per tenant.
CREATE UNIQUE INDEX job_queue_billing_one ON job_queue (tenant_id, kind) WHERE kind IN ('billing.followups','billing.retainers') AND dead_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON billing_settings, billing_counter, billing_rate, invoice, receipt, receipt_allocation, billing_message,
  payment_link, payment_event, tally_ledger_map, tally_export_log, invoice_task TO worko_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_line, invoice_task, tally_ledger_map TO worko_app;
