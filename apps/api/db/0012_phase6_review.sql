-- Phase 6 review: server receipt time of a check-in (offline check-ins use the device time, D95) and the credits a
-- leave debit consumed (so a cancellation restores their expiry, D97).
ALTER TABLE attendance ADD COLUMN received_at timestamptz;
UPDATE attendance SET received_at = check_in_at WHERE received_at IS NULL;
ALTER TABLE leave_ledger ADD COLUMN consumed jsonb;
