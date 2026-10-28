-- Phase 3 review fixes: per-link share password lockout.
ALTER TABLE share_link ADD COLUMN failed_attempts int NOT NULL DEFAULT 0;
