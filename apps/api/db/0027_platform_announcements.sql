-- Platform announcements (super-admin → firms). Global table: tenant_id NULL = every firm.
CREATE TABLE platform_announcement (
  id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenant(id),
  title text NOT NULL, body text NOT NULL DEFAULT '', level text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'critical')),
  starts_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz, active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES platform_admin(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON platform_announcement (active, starts_at);
-- Firms read the ones addressed to them (the API filters by the caller's tenant).
GRANT SELECT ON platform_announcement TO worko_app;
