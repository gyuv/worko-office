-- Phase 5 review: retryable follow-up sends, receipts flagged for review (paid on a superseded link).
ALTER TABLE billing_message ADD COLUMN attempts int NOT NULL DEFAULT 1, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE billing_message DROP CONSTRAINT billing_message_status_check;
ALTER TABLE billing_message ADD CONSTRAINT billing_message_status_check CHECK (status IN ('pending','sent','failed','skipped'));
ALTER TABLE receipt ADD COLUMN needs_review boolean NOT NULL DEFAULT false, ADD COLUMN review_note text;
