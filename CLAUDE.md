# Worko — agent conventions

Practice & office management for Indian CA/CS firms. Web + Electron desktop + Expo Android, one NestJS backend.
Full spec: docs/PRD.md. Status: PROGRESS.md (update after every session). Gaps: docs/KNOWN_GAPS.md.

## Commands
- `pnpm install` · `pnpm build` · `pnpm test` · `pnpm typecheck`
- `docker compose up -d` (Postgres 16 + Redis + MinIO + Mailpit) · `pnpm dev` (API + web)
- `pnpm --filter @worko/<pkg> test` for one package

## Folder map
- `packages/domain` — config constant, identifiers (PAN/GSTIN/TAN/UDIN), INR/paise money, FY helpers, permission matrix
- `packages/rules` — compliance rule engine; `packs/*.json` are data, not code
- `packages/sync` — pure sync core (outbox, cursor pull, merge, conflict log) + simulator tests
- `apps/api` — NestJS (ESM). `db/*.sql` = ordered migrations with RLS
- `docs/` — PRD, ARCHITECTURE, DATA_MODEL, API (+ openapi.yaml), DECISIONS, COMPLIANCE_RULES, ROADMAP, INTEGRATIONS

## Conventions
- TypeScript strict, ESM, zod for every external input. Money is integer paise. Dates are IST calendar ISO strings.
- Never hard-code statutory due dates or prices in code — they live in rule packs / rate tables.
- Every tenant table: sync columns + `CALL make_tenant_table(...)` (RLS + version/cursor trigger).
- Uncertain external behaviour → adapter interface + mock + `// VERIFY AGAINST OFFICIAL DOCS` + KNOWN_GAPS entry.
- Product name only via `PRODUCT` in `@worko/domain`. All UI strings through i18n.

## Definition of done (per module)
Migration · API with validation + permission check + audit entry · web screen · mobile screen · desktop behaviour ·
unit + integration tests · demo seed data · PROGRESS.md line.
