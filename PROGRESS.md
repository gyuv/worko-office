# PROGRESS

_Last session: 2026-10-27._ Resume from the first unchecked item in docs/ROADMAP.md (Phase 1 → "DB access layer").

## Done & tested
- Phase 0 docs: PRD, ARCHITECTURE, DATA_MODEL, API + openapi.yaml, DECISIONS, COMPLIANCE_RULES, ROADMAP, INTEGRATIONS, KNOWN_GAPS, CLAUDE.md.
- Monorepo + CI + docker-compose + .env.example.
- `@worko/domain` — 13 tests.
- `@worko/rules` — engine + 18-rule seed pack (unverified) — 14 golden tests.
- `@worko/sync` — pure sync core — 55 tests (50 seeded convergence simulations).
- `@worko/api` — NestJS skeleton: `/v1/health`, `/v1/rules/{pack,preview,extension-impact}` — 3 tests; boots with `pnpm --filter @worko/api build && node apps/api/dist/main.js`.
- `apps/api/db/0001_foundation.sql` — RLS + sync trigger, verified on Postgres 16 (tenant isolation, cross-tenant insert rejected, version/cursor bump).

## Next
1. Drizzle + tenant transaction interceptor; run migrations in API integration tests against real Postgres.
2. Auth module (password/OTP/TOTP/refresh/devices) + permission guard + audit interceptor.
3. Web/desktop/mobile shells; i18n; ui-tokens; OpenAPI codegen.
