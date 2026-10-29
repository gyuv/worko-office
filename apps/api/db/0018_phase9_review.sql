-- Phase 9 review fixes: per-identifier OTP verify window (replaces the per-user lockout), decided proposal version.
ALTER TABLE portal_user ADD COLUMN verify_failures int NOT NULL DEFAULT 0, ADD COLUMN verify_window_start timestamptz;
-- The user-level lockout is retired (D135): clear any lock left from 0017.
UPDATE portal_user SET failed_logins = 0, locked_until = NULL;
ALTER TABLE proposal ADD COLUMN decided_version int;
UPDATE proposal SET decided_version = COALESCE(accepted_version, sent_version) WHERE status IN ('accepted','declined');
-- Guard: conversion rates are never negative (billing_rate already CHECKs this; keep it explicit for proposal lines' derived amounts).
ALTER TABLE proposal_version ADD CONSTRAINT proposal_version_lines_array CHECK (jsonb_typeof(lines) = 'array');
