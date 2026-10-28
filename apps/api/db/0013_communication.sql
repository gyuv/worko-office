-- Phase 7: communication hub (M13) — channels, consent, templates, rates/caps, client timeline, broadcasts, team chat,
-- calendar (internal events, external sync, ICS feeds) and appointments. Money = bigint paise; times are timestamptz (IST in UI).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Firm communication policy (consent, quiet hours, caps, broadcast approval, chat edit window): one validated jsonb per tenant.
CREATE TABLE comm_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id), settings jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
ALTER TABLE comm_settings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON comm_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Default per-message rate card (data, not code; UNVERIFIED indicative values — firms override per tenant).
CREATE TABLE comm_rate_card (
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','sms')), category text NOT NULL CHECK (category IN ('transactional','utility','marketing','*')),
  paise bigint NOT NULL CHECK (paise >= 0), effective_from date NOT NULL, effective_to date, verified boolean NOT NULL DEFAULT false, note text,
  PRIMARY KEY (channel, category, effective_from)
);
-- VERIFY AGAINST OFFICIAL DOCS: Meta WhatsApp conversation/message pricing for India and SMS aggregator DLT rates change often.
INSERT INTO comm_rate_card (channel, category, paise, effective_from, note) VALUES
  ('email', '*', 0, '2026-01-01', 'SMTP/mailbox: no per-message charge assumed'),
  ('whatsapp', 'marketing', 88, '2026-01-01', 'indicative, unverified'),
  ('whatsapp', 'utility', 13, '2026-01-01', 'indicative, unverified'),
  ('whatsapp', 'transactional', 13, '2026-01-01', 'indicative, unverified (billed as utility)'),
  ('sms', '*', 25, '2026-01-01', 'indicative per segment, unverified');

-- Tenant overrides of the rate card (effective-dated).
CREATE TABLE comm_rate (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','sms')), category text NOT NULL CHECK (category IN ('transactional','utility','marketing','*')),
  paise bigint NOT NULL CHECK (paise >= 0), effective_from date NOT NULL, effective_to date, note text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
ALTER TABLE comm_rate ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON comm_rate USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE UNIQUE INDEX comm_rate_once ON comm_rate (tenant_id, channel, category, effective_from);

-- Consent per address × channel (addresses normalised: +91… / lower-case email); client/contact kept for display.
CREATE TABLE comm_consent (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), channel text NOT NULL CHECK (channel IN ('email','whatsapp','sms')),
  address text NOT NULL, client_id uuid REFERENCES client(id), contact_id uuid REFERENCES contact(id),
  status text NOT NULL CHECK (status IN ('opted_in','opted_out')),
  opted_in_at timestamptz, opted_in_source text, opted_out_at timestamptz, opted_out_source text, keyword text, note text,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  UNIQUE (tenant_id, channel, address)
);
ALTER TABLE comm_consent ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON comm_consent USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX ON comm_consent (client_id);

CREATE TABLE comm_template (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), name text NOT NULL CHECK (name ~ '^[a-z0-9_]{2,60}$'),
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','sms')), category text NOT NULL CHECK (category IN ('transactional','utility','marketing')),
  language text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2}(_[A-Z]{2})?$'), subject text, body text NOT NULL, variables text[] NOT NULL DEFAULT '{}',
  -- Body is sensitive (e.g. mentions amounts): audit diffs carry metadata only.
  sensitive boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  provider_ref text, rejection_reason text, dlt_template_id text, submitted_at timestamptz, decided_at timestamptz,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('comm_template');
CREATE UNIQUE INDEX comm_template_name ON comm_template (tenant_id, name, channel, language) WHERE deleted_at IS NULL;

CREATE TABLE broadcast (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','sms')), template_id uuid NOT NULL REFERENCES comm_template(id),
  category text NOT NULL CHECK (category IN ('transactional','utility','marketing')), filters jsonb NOT NULL DEFAULT '{}', variables jsonb NOT NULL DEFAULT '{}',
  scheduled_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','scheduled','sending','completed','cancelled')),
  estimate jsonb, approved_by uuid, approved_at timestamptz, cancelled_at timestamptz, cancelled_by uuid, completed_at timestamptz,
  spent_paise bigint NOT NULL DEFAULT 0, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('broadcast');

-- One row per broadcast × address: the idempotency key for sending (a resumed job never sends twice).
CREATE TABLE broadcast_recipient (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), broadcast_id uuid NOT NULL REFERENCES broadcast(id),
  client_id uuid NOT NULL REFERENCES client(id), contact_id uuid REFERENCES contact(id), address text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped_optout','skipped_nocontact','skipped_cap','cancelled')),
  message_id uuid, cost_paise bigint NOT NULL DEFAULT 0, attempts int NOT NULL DEFAULT 0, error text, sent_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE broadcast_recipient ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broadcast_recipient USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
-- One send per address per broadcast (two clients sharing a contact number get one message); no-address rows once per client.
CREATE UNIQUE INDEX broadcast_recipient_once ON broadcast_recipient (broadcast_id, COALESCE(address, client_id::text));
CREATE INDEX ON broadcast_recipient (broadcast_id, status);

-- Every client communication: email/WhatsApp/SMS in and out, logged notes and calls. Unmatched inbound = client_id NULL (triage inbox).
CREATE TABLE comm_message (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), client_id uuid REFERENCES client(id), contact_id uuid REFERENCES contact(id),
  direction text NOT NULL CHECK (direction IN ('in','out','internal')), channel text NOT NULL CHECK (channel IN ('email','whatsapp','sms','note','call')),
  address text, subject text, body text NOT NULL DEFAULT '', template_id uuid REFERENCES comm_template(id), category text CHECK (category IN ('transactional','utility','marketing')),
  status text NOT NULL CHECK (status IN ('queued','sending','sent','delivered','read','failed','received','logged','cancelled')),
  meta jsonb NOT NULL DEFAULT '{}',
  provider text, provider_ref text, error text, cost_paise bigint NOT NULL DEFAULT 0, cap_warning boolean NOT NULL DEFAULT false,
  broadcast_id uuid REFERENCES broadcast(id), send_at timestamptz,
  triage text CHECK (triage IN ('unmatched','ambiguous','assigned')), assigned_by uuid, call_minutes int CHECK (call_minutes IS NULL OR call_minutes BETWEEN 0 AND 1440),
  created_by uuid, occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('comm_message');
CREATE INDEX comm_message_timeline ON comm_message (tenant_id, client_id, occurred_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX comm_message_inbox ON comm_message (tenant_id, occurred_at DESC) WHERE client_id IS NULL AND deleted_at IS NULL;
CREATE INDEX comm_message_usage ON comm_message (tenant_id, channel, occurred_at) WHERE direction = 'out';
CREATE UNIQUE INDEX comm_message_provider_ref ON comm_message (tenant_id, provider, provider_ref) WHERE provider_ref IS NOT NULL AND direction = 'in';

-- Webhook replay protection: one row per provider event id (body hash only, never the body).
CREATE TABLE comm_webhook_event (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), provider text NOT NULL, event_id text NOT NULL, body_sha256 text NOT NULL,
  outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, provider, event_id)
);
ALTER TABLE comm_webhook_event ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON comm_webhook_event USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Gmail/Outlook mailbox and calendar connections. Tokens only as KeyService ciphertext (AAD oauth:<id>:access|refresh);
-- never synced, never in audit diffs or logs. `state_hash` = sha256 of the single-use OAuth state nonce while pending.
CREATE TABLE oauth_connection (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  provider text NOT NULL CHECK (provider IN ('mock','google','microsoft')), purpose text NOT NULL CHECK (purpose IN ('mail','calendar')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked','error')),
  account_email text, scopes text[] NOT NULL DEFAULT '{}', access_token_enc bytea, refresh_token_enc bytea, expires_at timestamptz,
  state_hash text, sync_cursor_ext text, last_sync_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE oauth_connection ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_connection USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE UNIQUE INDEX oauth_connection_state ON oauth_connection (state_hash) WHERE state_hash IS NOT NULL;

-- ---------- Team chat (synced to members only) ----------
CREATE TABLE chat_channel (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('team','branch','direct','client','group')), name text NOT NULL,
  team_id uuid REFERENCES team(id), branch_id uuid REFERENCES branch(id), client_id uuid REFERENCES client(id),
  direct_key text, archived boolean NOT NULL DEFAULT false, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  CHECK ((kind = 'client') = (client_id IS NOT NULL)), CHECK ((kind = 'direct') = (direct_key IS NOT NULL))
);
CALL make_tenant_table('chat_channel');
CREATE UNIQUE INDEX chat_channel_direct ON chat_channel (tenant_id, direct_key) WHERE direct_key IS NOT NULL;

-- Membership + per-user read cursor (last read message).
CREATE TABLE chat_member (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), channel_id uuid NOT NULL REFERENCES chat_channel(id),
  user_id uuid NOT NULL REFERENCES app_user(id), role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  last_read_message_id uuid, last_read_at timestamptz, muted boolean NOT NULL DEFAULT false, joined_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('chat_member');
CREATE UNIQUE INDEX chat_member_once ON chat_member (channel_id, user_id);
CREATE INDEX ON chat_member (tenant_id, user_id) WHERE deleted_at IS NULL;

CREATE TABLE chat_message (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), channel_id uuid NOT NULL REFERENCES chat_channel(id),
  author_id uuid NOT NULL REFERENCES app_user(id), body text NOT NULL DEFAULT '' CHECK (length(body) <= 10000),
  mentions uuid[] NOT NULL DEFAULT '{}', attachment_doc_ids uuid[] NOT NULL DEFAULT '{}', edited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}'
);
CALL make_tenant_table('chat_message');
CREATE INDEX ON chat_message (channel_id, created_at DESC);
-- Soft delete removes the content (REST or sync path alike): only the tombstone remains.
CREATE FUNCTION chat_message_scrub() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN NEW.body := ''; NEW.mentions := '{}'; NEW.attachment_doc_ids := '{}'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chat_message_scrub BEFORE UPDATE ON chat_message FOR EACH ROW EXECUTE FUNCTION chat_message_scrub();

-- ---------- Calendar ----------
CREATE TABLE calendar_event (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), owner_id uuid NOT NULL REFERENCES app_user(id),
  kind text NOT NULL DEFAULT 'meeting' CHECK (kind IN ('meeting','personal','appointment','external')),
  title text NOT NULL, description text, location text, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, all_day boolean NOT NULL DEFAULT false,
  client_id uuid REFERENCES client(id), attendee_ids uuid[] NOT NULL DEFAULT '{}', appointment_id uuid,
  external_connection_id uuid REFERENCES oauth_connection(id), external_id text, external_etag text, busy boolean NOT NULL DEFAULT true,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0, field_versions jsonb NOT NULL DEFAULT '{}',
  CHECK (ends_at >= starts_at)
);
CALL make_tenant_table('calendar_event');
CREATE INDEX ON calendar_event (tenant_id, owner_id, starts_at) WHERE deleted_at IS NULL;
CREATE INDEX ON calendar_event USING gin (attendee_ids);
CREATE UNIQUE INDEX calendar_event_external ON calendar_event (external_connection_id, external_id) WHERE external_id IS NOT NULL;

-- ICS feed tokens: only the sha256 is stored; revocable.
CREATE TABLE ics_feed (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), user_id uuid NOT NULL REFERENCES app_user(id),
  token_hash text NOT NULL UNIQUE, mask_clients boolean NOT NULL DEFAULT false, label text,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, last_used_at timestamptz
);
ALTER TABLE ics_feed ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ics_feed USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ---------- Appointments ----------
CREATE TABLE booking_page (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), slug text NOT NULL CHECK (slug ~ '^[a-z0-9-]{2,60}$'), title text NOT NULL,
  description text, host_user_ids uuid[] NOT NULL CHECK (cardinality(host_user_ids) BETWEEN 1 AND 20),
  slot_minutes int NOT NULL DEFAULT 30 CHECK (slot_minutes BETWEEN 10 AND 480), buffer_minutes int NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
  working_hours jsonb NOT NULL, horizon_days int NOT NULL DEFAULT 30 CHECK (horizon_days BETWEEN 1 AND 180),
  min_notice_minutes int NOT NULL DEFAULT 120 CHECK (min_notice_minutes BETWEEN 0 AND 20160),
  create_task boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true, created_by uuid,
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0
);
CALL make_tenant_table('booking_page');
CREATE UNIQUE INDEX booking_page_slug ON booking_page (tenant_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE appointment (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), page_id uuid NOT NULL REFERENCES booking_page(id),
  host_user_id uuid NOT NULL REFERENCES app_user(id), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
  client_id uuid REFERENCES client(id), name text NOT NULL, email text, phone text, purpose text NOT NULL,
  event_id uuid REFERENCES calendar_event(id), task_id uuid REFERENCES task(id), manage_nonce text NOT NULL, reschedules int NOT NULL DEFAULT 0,
  reminders_sent text[] NOT NULL DEFAULT '{}',
  cancelled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  updated_by uuid, device_id text, sync_cursor bigint NOT NULL DEFAULT 0,
  CHECK (ends_at > starts_at),
  -- No double booking of a host, enforced by the database (the service also serialises per host).
  EXCLUDE USING gist (host_user_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'booked')
);
CALL make_tenant_table('appointment');

GRANT SELECT ON comm_rate_card TO worko_app;
GRANT SELECT, INSERT, UPDATE ON comm_settings, comm_rate, comm_consent, comm_template, broadcast, broadcast_recipient, comm_message, comm_webhook_event,
  oauth_connection, chat_channel, chat_member, chat_message, calendar_event, ics_feed, booking_page, appointment TO worko_app;
GRANT DELETE ON comm_rate TO worko_app;
