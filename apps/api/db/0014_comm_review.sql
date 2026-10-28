-- Phase 7 review: unverified consent from public bookings, explicit message format, broadcast template snapshots,
-- OAuth browser binding, booking client suggestions, attendee acceptance, outbound mail dedupe.
ALTER TABLE comm_consent DROP CONSTRAINT comm_consent_status_check;
ALTER TABLE comm_consent ADD CONSTRAINT comm_consent_status_check CHECK (status IN ('opted_in','opted_out','pending_verification'));

-- Email bodies are HTML only when the sender says so (templates); never guessed from content.
ALTER TABLE comm_message ADD COLUMN format text NOT NULL DEFAULT 'text' CHECK (format IN ('text','html'));
-- Mail imported from a mailbox (in or out) is unique per provider message id.
CREATE UNIQUE INDEX comm_message_mail_ref ON comm_message (tenant_id, provider, provider_ref) WHERE provider_ref IS NOT NULL AND channel = 'email' AND provider LIKE '%:mail:%';

-- What a broadcast actually sends: the approved template as it was when the broadcast was sent/approved.
ALTER TABLE broadcast ADD COLUMN template_version int, ADD COLUMN template_name text, ADD COLUMN template_language text,
  ADD COLUMN template_subject text, ADD COLUMN template_body text, ADD COLUMN template_dlt_id text;

-- OAuth: sha256 of the httpOnly browser-binding cookie set when the flow started.
ALTER TABLE oauth_connection ADD COLUMN binding_hash text;

-- Public bookings never link a client by themselves: staff confirm the suggestion.
ALTER TABLE appointment ADD COLUMN suggested_client_id uuid REFERENCES client(id);

-- Attendees are invited until they accept.
ALTER TABLE calendar_event ADD COLUMN accepted_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE calendar_event SET accepted_ids = attendee_ids;
