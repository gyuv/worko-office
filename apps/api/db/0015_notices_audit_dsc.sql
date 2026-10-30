-- Phase 8: notices (M7), audit workpapers + UDIN (M8), DSC register, licences and e-signature (M12).
-- Money = bigint paise; dates are IST calendar dates; times timestamptz. No DSC PIN/password and no Aadhaar number columns — by design.

-- Firm settings for this phase (notice buffer/escalation, expiry thresholds, PBC reminders, AI extraction opt-in): one validated jsonb.
CREATE TABLE practice_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id), settings jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
ALTER TABLE practice_settings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON practice_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ---------- Notices ----------
CREATE TABLE notice (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), client_id uuid NOT NULL REFERENCES client(id),
  authority text NOT NULL, level text NOT NULL, section text, reference_no text, din text, title text NOT NULL, description text,
  issue_date date, received_on date NOT NULL, response_due date, assessment_year text, financial_year text, period text,
  demand_paise bigint NOT NULL DEFAULT 0 CHECK (demand_paise >= 0),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','under_review','drafting','submitted','hearing','closed')),
  outcome text CHECK (outcome IN ('dropped','demand_confirmed','demand_reduced','appeal')), outcome_note text, final_demand_paise bigint CHECK (final_demand_paise IS NULL OR final_demand_paise >= 0),
  assignee_id uuid REFERENCES app_user(id), reviewer_id uuid REFERENCES app_user(id), task_id uuid REFERENCES task(id),
  appeal_of uuid REFERENCES notice(id), closed_at timestamptz, submitted_at timestamptz,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  CHECK ((status = 'closed') = (outcome IS NOT NULL)), CHECK (response_due IS NULL OR issue_date IS NULL OR response_due >= issue_date)
);
CALL make_tenant_table('notice');
CREATE INDEX ON notice (client_id);
CREATE INDEX notice_open ON notice (tenant_id, response_due) WHERE deleted_at IS NULL AND status <> 'closed';

CREATE TABLE notice_document (
  tenant_id uuid NOT NULL REFERENCES tenant(id), notice_id uuid NOT NULL REFERENCES notice(id), document_id uuid NOT NULL REFERENCES document(id),
  kind text NOT NULL CHECK (kind IN ('notice','reply','order','evidence','other')), linked_by uuid, linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notice_id, document_id)
);
ALTER TABLE notice_document ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notice_document USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- "AI drafts fields; I confirm": suggestions live here and never touch the notice until a user confirms chosen fields.
CREATE TABLE notice_extraction (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), client_id uuid NOT NULL REFERENCES client(id), notice_id uuid REFERENCES notice(id),
  document_id uuid NOT NULL REFERENCES document(id), document_version int NOT NULL, provider text NOT NULL,
  suggestions jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','discarded')),
  confirmed_fields text[] NOT NULL DEFAULT '{}', decided_by uuid, decided_at timestamptz, created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE notice_extraction ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notice_extraction USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE notice_hearing (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), notice_id uuid NOT NULL REFERENCES notice(id), client_id uuid NOT NULL REFERENCES client(id),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, venue text, virtual_link text,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','adjourned','held','cancelled')),
  adjourned_from uuid REFERENCES notice_hearing(id), adjournment_reason text, prep_done boolean NOT NULL DEFAULT false, outcome_note text,
  owner_id uuid REFERENCES app_user(id), calendar_event_id uuid REFERENCES calendar_event(id),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  CHECK (ends_at >= starts_at)
);
CALL make_tenant_table('notice_hearing');
CREATE INDEX ON notice_hearing (notice_id);
ALTER TABLE calendar_event DROP CONSTRAINT IF EXISTS calendar_event_kind_check;
ALTER TABLE calendar_event ADD CONSTRAINT calendar_event_kind_check CHECK (kind IN ('meeting','personal','appointment','external','hearing'));

-- ---------- Audit workpapers ----------
CREATE TABLE audit_programme (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), name text NOT NULL, audit_type text NOT NULL,
  sections jsonb NOT NULL DEFAULT '[]', udin_required boolean NOT NULL DEFAULT true, active boolean NOT NULL DEFAULT true,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audit_programme ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_programme USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE audit_engagement (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), client_id uuid NOT NULL REFERENCES client(id),
  fy text NOT NULL CHECK (fy ~ '^\d{4}-\d{2}$'), audit_type text NOT NULL, programme_id uuid REFERENCES audit_programme(id), programme_snapshot jsonb,
  partner_id uuid REFERENCES app_user(id), manager_id uuid REFERENCES app_user(id), task_id uuid REFERENCES task(id),
  status text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','fieldwork','review','reporting','closed')),
  udin_required boolean NOT NULL DEFAULT true, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
ALTER TABLE audit_engagement ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_engagement USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE UNIQUE INDEX audit_engagement_once ON audit_engagement (tenant_id, client_id, fy, audit_type) WHERE deleted_at IS NULL;
CREATE INDEX ON audit_engagement (task_id);

CREATE TABLE audit_procedure (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), engagement_id uuid NOT NULL REFERENCES audit_engagement(id),
  section_key text NOT NULL, section_title text NOT NULL, key text NOT NULL, title text NOT NULL, required_evidence text[] NOT NULL DEFAULT '{}', sort int NOT NULL DEFAULT 0,
  not_applicable boolean NOT NULL DEFAULT false, conclusion text,
  prepared_by uuid REFERENCES app_user(id), prepared_at timestamptz, reviewed_by uuid REFERENCES app_user(id), reviewed_at timestamptz,
  partner_by uuid REFERENCES app_user(id), partner_at timestamptz, evidence_changed_at timestamptz,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, section_key, key),
  CHECK (reviewed_by IS NULL OR prepared_by IS NOT NULL), CHECK (partner_by IS NULL OR reviewed_by IS NOT NULL),
  CHECK (reviewed_by IS NULL OR reviewed_by <> prepared_by), CHECK (partner_by IS NULL OR partner_by <> prepared_by)
);
ALTER TABLE audit_procedure ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_procedure USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Append-only sign-off trail (signed / invalidated / reopened). The app role gets no UPDATE/DELETE on it.
CREATE TABLE audit_signoff_event (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), procedure_id uuid NOT NULL REFERENCES audit_procedure(id),
  level text NOT NULL CHECK (level IN ('preparer','reviewer','partner')), action text NOT NULL CHECK (action IN ('signed','invalidated','reopened')),
  user_id uuid, reason text, at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audit_signoff_event ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_signoff_event USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON audit_signoff_event (procedure_id, at);

CREATE TABLE audit_workpaper (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), engagement_id uuid NOT NULL REFERENCES audit_engagement(id),
  procedure_id uuid NOT NULL REFERENCES audit_procedure(id), document_id uuid NOT NULL REFERENCES document(id), document_version int NOT NULL,
  linked_by uuid, linked_at timestamptz NOT NULL DEFAULT now(), unlinked_at timestamptz, unlinked_by uuid
);
ALTER TABLE audit_workpaper ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_workpaper USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON audit_workpaper (procedure_id);

CREATE TABLE pbc_item (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), engagement_id uuid NOT NULL REFERENCES audit_engagement(id), client_id uuid NOT NULL REFERENCES client(id),
  title text NOT NULL, description text, due_date date,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','received','accepted','rejected')),
  document_ids uuid[] NOT NULL DEFAULT '{}', rejection_reason text, decided_by uuid, decided_at timestamptz, received_at timestamptz,
  reminder_count int NOT NULL DEFAULT 0, last_reminded_on date, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
ALTER TABLE pbc_item ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pbc_item USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON pbc_item (engagement_id);

-- UDINs are generated on the ICAI portal by the signing member; we only record them (format-validated, unique per firm).
CREATE TABLE udin_record (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), client_id uuid NOT NULL REFERENCES client(id),
  engagement_id uuid REFERENCES audit_engagement(id), task_id uuid REFERENCES task(id),
  udin text NOT NULL CHECK (udin ~ '^[0-9]{8}[A-Z0-9]{10}$'), document_type text NOT NULL, generated_on date NOT NULL,
  membership_no text NOT NULL CHECK (membership_no ~ '^[0-9]{6}$'), signing_partner_id uuid REFERENCES app_user(id), document_id uuid REFERENCES document(id),
  revoked_at timestamptz, revoked_by uuid, revoke_reason text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE udin_record ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON udin_record USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE UNIQUE INDEX udin_record_unique ON udin_record (tenant_id, udin);
CREATE INDEX ON udin_record (engagement_id);

-- ---------- DSC register (metadata only: never a token PIN or password) ----------
CREATE TABLE dsc (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), client_id uuid REFERENCES client(id),
  holder_kind text NOT NULL CHECK (holder_kind IN ('client_contact','staff')), contact_id uuid REFERENCES contact(id), holder_user_id uuid REFERENCES app_user(id),
  holder_name text NOT NULL, dsc_class text NOT NULL, dsc_type text NOT NULL CHECK (dsc_type IN ('sign','encrypt','combo')), issuer text NOT NULL, serial_no text,
  valid_from date NOT NULL, valid_to date NOT NULL, token_label text,
  custody text NOT NULL DEFAULT 'in_office' CHECK (custody IN ('in_office','with_client','with_staff')), custody_user_id uuid REFERENCES app_user(id),
  alerts_sent int[] NOT NULL DEFAULT '{}', renewal_task_id uuid REFERENCES task(id), notes text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  CHECK (valid_to >= valid_from), CHECK ((holder_kind = 'client_contact') = (client_id IS NOT NULL)), CHECK (holder_kind <> 'staff' OR holder_user_id IS NOT NULL),
  CHECK ((custody = 'with_staff') = (custody_user_id IS NOT NULL))
);
CALL make_tenant_table('dsc');
CREATE INDEX ON dsc (client_id);
CREATE UNIQUE INDEX dsc_serial ON dsc (tenant_id, issuer, serial_no) WHERE serial_no IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE dsc_custody (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), dsc_id uuid NOT NULL REFERENCES dsc(id),
  from_custody text NOT NULL, to_custody text NOT NULL, to_user_id uuid REFERENCES app_user(id), counterparty text, purpose text,
  moved_by uuid, moved_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz, acknowledged_by uuid, acknowledged_name text
);
ALTER TABLE dsc_custody ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dsc_custody USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON dsc_custody (dsc_id, moved_at);

-- ---------- Licences / registrations ----------
CREATE TABLE licence (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), client_id uuid NOT NULL REFERENCES client(id),
  licence_type text NOT NULL, number text, authority text, valid_from date, valid_to date, renewal_due date,
  document_ids uuid[] NOT NULL DEFAULT '{}', alerts_sent int[] NOT NULL DEFAULT '{}', renewal_task_id uuid REFERENCES task(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','renewal_in_progress','lapsed','surrendered')), notes text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
ALTER TABLE licence ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON licence USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON licence (client_id);

-- ---------- E-signature ----------
CREATE TABLE esign_request (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), title text NOT NULL, bulk boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'parallel' CHECK (mode IN ('parallel','sequential')), provider text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','partially_failed','cancelled')),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), cancelled_at timestamptz, cancelled_by uuid, completed_at timestamptz,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE esign_request ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esign_request USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE esign_item (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), request_id uuid NOT NULL REFERENCES esign_request(id),
  document_id uuid NOT NULL REFERENCES document(id), document_version int NOT NULL, client_id uuid REFERENCES client(id), original_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','signed','failed','cancelled')),
  provider_txn_id text, signed_version int, certificate_document_id uuid REFERENCES document(id), signed_sha256 text,
  attempts int NOT NULL DEFAULT 0, error text, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE esign_item ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esign_item USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON esign_item (request_id);
CREATE UNIQUE INDEX esign_item_txn ON esign_item (tenant_id, provider_txn_id) WHERE provider_txn_id IS NOT NULL;

CREATE TABLE esign_signer (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), item_id uuid NOT NULL REFERENCES esign_item(id), request_id uuid NOT NULL REFERENCES esign_request(id),
  ord int NOT NULL DEFAULT 1, kind text NOT NULL CHECK (kind IN ('contact','staff')), contact_id uuid REFERENCES contact(id), user_id uuid REFERENCES app_user(id),
  name text NOT NULL, email text, phone text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','notified','signed','declined','cancelled')),
  link_nonce text NOT NULL, notified_at timestamptz, signed_at timestamptz, provider_signer_ref text,
  -- Only what the provider returns already masked (e.g. 'XXXXXXXX1234'); a full 12-digit Aadhaar number is refused by the CHECK.
  masked_id text CHECK (masked_id IS NULL OR masked_id !~ '[0-9]{5,}'), signer_name_as_per_id text, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE esign_signer ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esign_signer USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON esign_signer (item_id, ord);

CREATE TABLE esign_webhook_event (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), provider text NOT NULL, event_id text NOT NULL, body_sha256 text NOT NULL,
  outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, provider, event_id)
);
ALTER TABLE esign_webhook_event ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esign_webhook_event USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- One live daily practice job per tenant (notice escalations, DSC/licence expiry, PBC reminders).
CREATE UNIQUE INDEX job_queue_practice_one ON job_queue (tenant_id, kind) WHERE kind = 'practice.daily' AND dead_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON practice_settings, notice, notice_extraction, notice_hearing, audit_programme, audit_engagement, audit_procedure,
  audit_workpaper, pbc_item, udin_record, dsc, licence, esign_request, esign_item, esign_signer, esign_webhook_event TO worko_app;
GRANT SELECT, INSERT, DELETE ON notice_document TO worko_app;
GRANT SELECT, INSERT ON audit_signoff_event TO worko_app;
GRANT SELECT, INSERT, UPDATE ON dsc_custody TO worko_app;
