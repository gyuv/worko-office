-- Managed Postgres (Neon, Render, RDS…): the migrating owner is not a superuser. On PG16+ the role that created
-- worko_app holds it WITH ADMIN but without SET, so `SET LOCAL ROLE worko_app` fails. Grant the login role
-- membership explicitly. Superusers already can SET ROLE; tolerate a role that lacks ADMIN on worko_app.
DO $$ BEGIN
  IF NOT pg_has_role(current_user, 'worko_app', 'MEMBER') OR NOT pg_has_role(current_user, 'worko_app', 'USAGE') THEN
    IF current_setting('server_version_num')::int >= 160000 THEN
      EXECUTE format('GRANT worko_app TO %I WITH SET TRUE, INHERIT FALSE', current_user);
    ELSE
      EXECUTE format('GRANT worko_app TO %I', current_user);
    END IF;
  END IF;
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
  RAISE NOTICE 'could not grant worko_app to %; grant it manually', current_user;
END $$;
