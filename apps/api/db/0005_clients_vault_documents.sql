-- Phase 3: clients, contacts, registrations, groups, custom fields, credential vault, documents, registers.
-- Synced tables carry field_versions. Visibility-defining columns (branch/partner/manager/team/staff/groups/
-- sensitive/allowed users) are REST-only so every visibility change goes through revocation bookkeeping.

ALTER TABLE device_session DROP CONSTRAINT IF EXISTS device_session_platform_check;
ALTER TABLE device_session ADD CONSTRAINT device_session_platform_check CHECK (platform IN ('web','desktop','android','extension'));
ALTER TABLE device_session ADD COLUMN elevated_until timestamptz;   -- step-up window for sensitive actions
ALTER TABLE tenant ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';

-- Per-tenant data encryption key, wrapped by the KMS master key (envelope encryption).
CREATE TABLE tenant_key (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id), kek_id text NOT NULL, wrapped_dek bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_key ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_key USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE client_group (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL, kind text NOT NULL DEFAULT 'group' CHECK (kind IN ('family','group','other')),
  parent_id uuid REFERENCES client_group(id), notes text,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('client_group');

CREATE TABLE client (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  file_no text, name text NOT NULL, trade_name text,
  entity_type text NOT NULL CHECK (entity_type IN ('INDIVIDUAL','PROPRIETORSHIP','PARTNERSHIP','LLP','PRIVATE_COMPANY','PUBLIC_COMPANY','OPC','HUF','TRUST','AOP_BOI','SOCIETY','GOVERNMENT','OTHER')),
  pan text, tan text, cin text, udyam text, iec text,
  aadhaar_enc bytea, aadhaar_last4 text,
  bank_accounts_enc bytea, bank_accounts_masked jsonb NOT NULL DEFAULT '[]',
  dob date, email text, phone text, addresses jsonb NOT NULL DEFAULT '[]',
  source text, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','prospect')),
  tags text[] NOT NULL DEFAULT '{}', custom jsonb NOT NULL DEFAULT '{}', notes text,
  compliance_profile jsonb NOT NULL DEFAULT '{}',
  -- visibility (REST-only)
  branch_id uuid REFERENCES branch(id), partner_id uuid REFERENCES app_user(id), manager_id uuid REFERENCES app_user(id),
  team_id uuid REFERENCES team(id), staff_ids uuid[] NOT NULL DEFAULT '{}', group_ids uuid[] NOT NULL DEFAULT '{}',
  sensitive boolean NOT NULL DEFAULT false, allowed_user_ids uuid[] NOT NULL DEFAULT '{}',
  merged_into uuid REFERENCES client(id), created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('client');
CREATE UNIQUE INDEX client_file_no ON client (tenant_id, lower(file_no)) WHERE file_no IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX client_pan ON client (tenant_id, pan) WHERE deleted_at IS NULL;
CREATE INDEX client_phone ON client (tenant_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX client_name_trgm ON client USING gin (lower(name) gin_trgm_ops);
CREATE INDEX client_groups ON client USING gin (group_ids);
CREATE INDEX client_search ON client USING gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(trade_name,'') || ' ' || coalesce(file_no,'') || ' ' || coalesce(pan,'')));

CREATE TABLE client_registration (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), client_id uuid NOT NULL REFERENCES client(id),
  kind text NOT NULL CHECK (kind IN ('GSTIN','TAN','CIN','LLPIN','DIN','UDYAM','IEC','PF','ESI','PT','FSSAI','SHOPS','OTHER')),
  number text NOT NULL, state_code text, status text, registered_on date, is_primary boolean NOT NULL DEFAULT false, meta jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('client_registration');
CREATE UNIQUE INDEX client_registration_unique ON client_registration (tenant_id, kind, upper(number)) WHERE deleted_at IS NULL AND kind IN ('GSTIN','TAN','CIN','LLPIN');
CREATE INDEX ON client_registration (client_id);

CREATE TABLE contact (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), client_id uuid NOT NULL REFERENCES client(id),
  name text NOT NULL, role text, email text, phone text, whatsapp text, dob date, anniversary date,
  is_primary boolean NOT NULL DEFAULT false, notes text,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('contact');
CREATE INDEX ON contact (client_id);
CREATE INDEX contact_phone ON contact (tenant_id, phone) WHERE deleted_at IS NULL;

CREATE TABLE custom_field_def (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity text NOT NULL CHECK (entity IN ('client')), key text NOT NULL, label text NOT NULL,
  type text NOT NULL CHECK (type IN ('text','number','date','select','boolean')), options jsonb NOT NULL DEFAULT '[]',
  required boolean NOT NULL DEFAULT false, sort int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('custom_field_def');
CREATE UNIQUE INDEX ON custom_field_def (tenant_id, entity, key) WHERE deleted_at IS NULL;

-- Rows a user could see before a visibility change and can't any more (only those users are told).
CREATE TABLE sync_revocation (
  id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, table_name text NOT NULL, row_id uuid NOT NULL,
  user_ids uuid[] NOT NULL, sync_cursor bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sync_revocation ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_revocation USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON sync_revocation (tenant_id, sync_cursor);
CREATE INDEX ON sync_revocation USING gin (user_ids);

-- ---------- Vault ----------
CREATE TABLE vault_secret (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), client_id uuid REFERENCES client(id),
  portal text NOT NULL CHECK (portal IN ('GST','INCOME_TAX','TRACES','MCA','EPFO','ESIC','BANK','PT','DGFT','OTHER')),
  label text NOT NULL, login_url text, username_hint text NOT NULL,
  username_enc bytea NOT NULL, secret_enc bytea NOT NULL, extra_enc bytea,
  rotated_at timestamptz, last_revealed_at timestamptz, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('vault_secret');
CREATE INDEX ON vault_secret (client_id);

CREATE TABLE extension_pair_code (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES app_user(id),
  code_hash text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz, attempts int NOT NULL DEFAULT 0
);
ALTER TABLE extension_pair_code ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON extension_pair_code USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ---------- Documents ----------
CREATE TABLE document (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), client_id uuid REFERENCES client(id),
  fy text, category text NOT NULL DEFAULT 'General', name text NOT NULL, mime text NOT NULL, size bigint NOT NULL,
  sha256 text NOT NULL, storage_key text NOT NULL, current_version int NOT NULL DEFAULT 1,
  tags text[] NOT NULL DEFAULT '{}', permanent boolean NOT NULL DEFAULT false, expires_on date,
  retention_until date, legal_hold boolean NOT NULL DEFAULT false, extracted_text text,
  scan_status text NOT NULL DEFAULT 'clean' CHECK (scan_status IN ('pending','clean','infected')),
  uploaded_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('document');
CREATE INDEX ON document (client_id, fy, category);
-- array_to_string is only STABLE; this wrapper is safe to mark IMMUTABLE (pure text concatenation).
CREATE FUNCTION document_search_text(n text, c text, t text[], x text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT coalesce(n,'') || ' ' || coalesce(c,'') || ' ' || coalesce(array_to_string(t, ' '), '') || ' ' || coalesce(x,'') $$;
CREATE INDEX document_search ON document USING gin (to_tsvector('simple', document_search_text(name, category, tags, extracted_text)));

CREATE TABLE document_version (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, document_id uuid NOT NULL REFERENCES document(id),
  version int NOT NULL, storage_key text NOT NULL, size bigint NOT NULL, sha256 text NOT NULL, mime text NOT NULL,
  note text, uploaded_by uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (document_id, version)
);
ALTER TABLE document_version ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_version USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE share_link (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, document_id uuid NOT NULL REFERENCES document(id),
  token_hash text NOT NULL UNIQUE, password_hash text, expires_at timestamptz NOT NULL, max_downloads int, downloads int NOT NULL DEFAULT 0,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
ALTER TABLE share_link ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON share_link USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE document_access_log (
  id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, document_id uuid NOT NULL, user_id uuid, share_link_id uuid,
  action text NOT NULL, ip inet, at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE document_access_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON document_access_log FOR SELECT USING (tenant_id = current_tenant());
CREATE POLICY tenant_insert ON document_access_log FOR INSERT WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON document_access_log (document_id, at DESC);

-- ---------- Inward / outward registers ----------
CREATE TABLE register_counter (tenant_id uuid NOT NULL, kind text NOT NULL, fy text NOT NULL, next int NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id, kind, fy));
ALTER TABLE register_counter ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON register_counter USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE inward_entry (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), number text NOT NULL, fy text NOT NULL,
  client_id uuid NOT NULL REFERENCES client(id), received_on date NOT NULL,
  mode text NOT NULL CHECK (mode IN ('physical','email','whatsapp','courier','portal','other')),
  from_name text, from_phone text, description text NOT NULL, items jsonb NOT NULL DEFAULT '[]',
  returnable boolean NOT NULL DEFAULT false, due_back date, returned_on date,
  signature_doc_id uuid REFERENCES document(id), received_by uuid, task_id uuid,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, number)
);
CALL make_tenant_table('inward_entry');
CREATE INDEX ON inward_entry (tenant_id, received_on DESC);
CREATE INDEX ON inward_entry (client_id);

CREATE TABLE outward_entry (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), number text NOT NULL, fy text NOT NULL,
  client_id uuid NOT NULL REFERENCES client(id), sent_on date NOT NULL,
  mode text NOT NULL CHECK (mode IN ('hand','courier','email','whatsapp','post','other')),
  to_name text, to_phone text, courier_name text, tracking_no text, description text NOT NULL, items jsonb NOT NULL DEFAULT '[]',
  original boolean NOT NULL DEFAULT false, to_be_received_back boolean NOT NULL DEFAULT false, received_back_on date,
  signature_doc_id uuid REFERENCES document(id), sent_by uuid,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, number)
);
CALL make_tenant_table('outward_entry');
CREATE INDEX ON outward_entry (tenant_id, sent_on DESC);
CREATE INDEX ON outward_entry (client_id);

GRANT SELECT, INSERT, UPDATE ON tenant_key, client_group, client, client_registration, contact, custom_field_def, sync_revocation,
  vault_secret, extension_pair_code, document, document_version, share_link, register_counter, inward_entry, outward_entry TO worko_app;
GRANT SELECT, INSERT ON document_access_log TO worko_app;
GRANT UPDATE (settings) ON tenant TO worko_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO worko_app;
