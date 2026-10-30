-- Phase 9: client portal (M16) and leads & proposals (M4).
-- Portal identities are NOT app_user rows: separate tables, sessions and token issuer, so a portal token can never reach a staff route (D126).
-- Money = bigint paise. OTP codes and refresh tokens are stored as hashes only; profile-change payloads are KeyService ciphertext.

-- ---------- Documents / clients / comm hooks ----------
ALTER TABLE document ADD COLUMN client_visible boolean NOT NULL DEFAULT false,
  ADD COLUMN source text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','portal','system')),
  ADD COLUMN portal_user_id uuid;
CREATE INDEX document_client_visible ON document (client_id) WHERE client_visible AND deleted_at IS NULL;
ALTER TABLE client ADD COLUMN portal_enabled boolean NOT NULL DEFAULT false;
-- Portal thread messages live on the client timeline as channel 'portal' (in = from the client, out = staff reply).
ALTER TABLE comm_message DROP CONSTRAINT IF EXISTS comm_message_channel_check;
ALTER TABLE comm_message ADD CONSTRAINT comm_message_channel_check CHECK (channel IN ('email','whatsapp','sms','note','call','portal'));
ALTER TABLE comm_message ADD COLUMN portal_user_id uuid, ADD COLUMN document_ids uuid[] NOT NULL DEFAULT '{}';

-- ---------- Portal ----------
CREATE TABLE portal_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id), settings jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
ALTER TABLE portal_settings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE portal_user (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), name text NOT NULL,
  email text, phone text, -- normalised (lower-case email, +91… phone); at least one
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')),
  failed_logins int NOT NULL DEFAULT 0, locked_until timestamptz, last_login_at timestamptz,
  invited_by uuid, created_at timestamptz NOT NULL DEFAULT now(), version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
ALTER TABLE portal_user ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_user USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE UNIQUE INDEX portal_user_email ON portal_user (tenant_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX portal_user_phone ON portal_user (tenant_id, phone) WHERE phone IS NOT NULL;

-- One row per portal user × client (group companies = several rows), with granular grants (validated jsonb, @worko/domain portalGrantsSchema).
CREATE TABLE portal_access (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), portal_user_id uuid NOT NULL REFERENCES portal_user(id),
  client_id uuid NOT NULL REFERENCES client(id), contact_id uuid REFERENCES contact(id), grants jsonb NOT NULL DEFAULT '{}',
  revoked_at timestamptz, revoked_by uuid, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portal_user_id, client_id)
);
ALTER TABLE portal_access ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_access USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON portal_access (client_id);

CREATE TABLE portal_otp (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), portal_user_id uuid NOT NULL REFERENCES portal_user(id),
  channel text NOT NULL CHECK (channel IN ('email','sms')), code_hash text NOT NULL, attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
ALTER TABLE portal_otp ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_otp USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON portal_otp (portal_user_id, created_at);

CREATE TABLE portal_session (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), portal_user_id uuid NOT NULL REFERENCES portal_user(id),
  platform text NOT NULL CHECK (platform IN ('web','android')), label text, refresh_token_hash text NOT NULL,
  last_seen_at timestamptz, revoked_at timestamptz, ip inet, user_agent text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portal_session ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_session USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE portal_refresh_token (
  hash text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), session_id uuid NOT NULL REFERENCES portal_session(id),
  rotated_at timestamptz, expires_at timestamptz NOT NULL
);
ALTER TABLE portal_refresh_token ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_refresh_token USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Contact-detail change requests from the portal: the requested values are PII → KeyService ciphertext (AAD portal_profile_request:<id>:changes).
CREATE TABLE portal_profile_request (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), portal_user_id uuid NOT NULL REFERENCES portal_user(id),
  client_id uuid NOT NULL REFERENCES client(id), contact_id uuid REFERENCES contact(id), fields text[] NOT NULL, changes_enc bytea NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')), reason text,
  decided_by uuid, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portal_profile_request ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_profile_request USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Portal requests answered (PBC items get the reply text; tasks keep it in pending_response).
ALTER TABLE pbc_item ADD COLUMN client_response text, ADD COLUMN responded_at timestamptz;

-- ---------- Leads & proposals ----------
CREATE TABLE crm_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id), settings jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
ALTER TABLE crm_settings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE lead (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL, company text, email text, phone text, pan text, gstin text, entity_type text, state_code char(2),
  source text NOT NULL DEFAULT 'other', owner_id uuid REFERENCES app_user(id), branch_id uuid REFERENCES branch(id),
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','contacted','qualified','proposal','won','lost')),
  position double precision NOT NULL DEFAULT 1024, lost_reason text,
  expected_value_paise bigint NOT NULL DEFAULT 0 CHECK (expected_value_paise >= 0), next_followup_on date, notes text,
  client_id uuid REFERENCES client(id), converted_at timestamptz, stage_changed_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  CHECK ((stage = 'lost') = (lost_reason IS NOT NULL))
);
ALTER TABLE lead ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX lead_board ON lead (tenant_id, stage, position) WHERE deleted_at IS NULL;
CREATE INDEX lead_pan ON lead (tenant_id, pan) WHERE deleted_at IS NULL;

CREATE TABLE lead_activity (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), lead_id uuid NOT NULL REFERENCES lead(id),
  kind text NOT NULL CHECK (kind IN ('note','call','email','meeting','stage','proposal','system')), body text, meta jsonb NOT NULL DEFAULT '{}',
  created_by uuid, at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_activity ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_activity USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON lead_activity (lead_id, at DESC);

CREATE TABLE proposal (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), lead_id uuid NOT NULL REFERENCES lead(id),
  number text NOT NULL, title text NOT NULL, entity_id uuid REFERENCES firm_entity(id), place_of_supply char(2),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined','expired','withdrawn')),
  current_version int NOT NULL DEFAULT 1, sent_version int, accepted_version int,
  sent_at timestamptz, decided_at timestamptz, accepted_name text, accepted_ip inet, accepted_ua text, declined_reason text,
  converted_at timestamptz, conversion jsonb, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (tenant_id, number)
);
ALTER TABLE proposal ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON proposal USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON proposal (lead_id);

-- Immutable once sent: editing a sent proposal creates the next version. link_nonce rotates per send (old links stop working for acceptance).
CREATE TABLE proposal_version (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), proposal_id uuid NOT NULL REFERENCES proposal(id), version int NOT NULL,
  lines jsonb NOT NULL DEFAULT '[]', terms text, valid_until date, totals jsonb NOT NULL DEFAULT '{}', supply_type text NOT NULL,
  link_nonce text, sent_at timestamptz, sent_via text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, version)
);
ALTER TABLE proposal_version ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON proposal_version USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE FUNCTION proposal_version_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sent_at IS NOT NULL AND (NEW.lines IS DISTINCT FROM OLD.lines OR NEW.terms IS DISTINCT FROM OLD.terms OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.totals IS DISTINCT FROM OLD.totals) THEN
    RAISE EXCEPTION 'a sent proposal version is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proposal_version_lock BEFORE UPDATE ON proposal_version FOR EACH ROW EXECUTE FUNCTION proposal_version_lock();

CREATE TABLE proposal_counter (tenant_id uuid PRIMARY KEY REFERENCES tenant(id), next int NOT NULL DEFAULT 1);
ALTER TABLE proposal_counter ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON proposal_counter USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

GRANT SELECT, INSERT, UPDATE ON portal_settings, portal_user, portal_access, portal_otp, portal_session, portal_refresh_token, portal_profile_request,
  crm_settings, lead, lead_activity, proposal, proposal_version, proposal_counter TO worko_app;
