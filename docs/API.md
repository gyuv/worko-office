# API

Contract: `docs/openapi.yaml` (OpenAPI 3.1). REST under `/v1`, JSON, zod-validated, errors `{ message, issues[] }`.
Typed client `@worko/api-client` will be generated from it (openapi-typescript) — planned in Phase 1 completion.

## Conventions
- Auth: `Authorization: Bearer <access>`; refresh via `POST /auth/refresh` (rotation, reuse detection kills the family).
- Idempotency: all POST/PATCH accept `Idempotency-Key`; replays return the stored response.
- Pagination: cursor-based `?after=&limit=`. Filtering via saved-view definitions, never raw SQL.
- Sync: `POST /sync/push`, `GET /sync/pull?since=`; WS `/v1/realtime` emits `{table, cursor}` hints.
- Public API: per-firm API keys with scopes + rate limits; webhooks signed with HMAC-SHA256.

## Implemented now
`GET /health`, `GET /rules/pack`, `POST /rules/preview`, `POST /rules/extension-impact`.
