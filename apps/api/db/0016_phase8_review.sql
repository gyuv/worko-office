-- Phase 8 review fixes: engagement workflow + UDIN-revoked-after-close flag, partner N/A marks, idempotent e-sign finalize.
ALTER TABLE audit_engagement ADD COLUMN udin_revoked_after_close boolean NOT NULL DEFAULT false;
ALTER TABLE audit_procedure ADD COLUMN na_by uuid REFERENCES app_user(id), ADD COLUMN na_by_partner boolean NOT NULL DEFAULT false;
-- 'reporting' is kept only for rows created before the workflow fix; new moves use planning → fieldwork → review → closed.
-- finalize() records progress so a retry never adds a second signed version (D119 revised).
ALTER TABLE esign_item ADD COLUMN finalize_state text CHECK (finalize_state IN ('version_stored','certificate_stored')),
  ADD COLUMN signed_label text;
