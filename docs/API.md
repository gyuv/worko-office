# API

Contract: `docs/openapi.yaml` (OpenAPI 3.1). REST under `/v1`, JSON, zod-validated, errors `{ message, issues[] }`.
Typed client `@worko/api-client` is generated from it (`pnpm --filter @worko/api-client generate`); CI fails if it is stale, and `apps/api/test/contract.int.test.ts` fails if routes and spec differ.

## Conventions
- Auth: `Authorization: Bearer <access>`; refresh via `POST /auth/refresh` (rotation, reuse detection kills the family).
- Idempotency: all POST/PATCH will accept `Idempotency-Key` (table exists; middleware lands with the first business mutations in Phase 2/3).
- Pagination: cursor-based `?after=&limit=`. Filtering via saved-view definitions, never raw SQL.
- Sync: `POST /sync/push`, `GET /sync/pull?since=`; WS `/v1/realtime` emits `{table, cursor}` hints.
- Public API: per-firm API keys with scopes + rate limits; webhooks signed with HMAC-SHA256.

## Implemented now
| Area | Endpoints |
|---|---|
| System | `GET /health` |
| Tenancy | `POST /tenants/signup` (public, rate-limited, `ALLOW_SIGNUP=false` disables) |
| Auth | `POST /auth/login`, `/auth/otp/request`, `/auth/otp/verify`, `/auth/refresh`, `/auth/logout`, `GET /auth/sessions`, `POST /auth/sessions/{id}/revoke`, `/auth/sessions/{id}/wipe`, `/auth/totp/setup`, `/auth/totp/enable` |
| Users | `GET /me`, `GET/POST /users`, `GET /roles` |
| Audit | `GET /audit`, `GET /audit/verify` |
| Rules | `GET /rules/pack`, `POST /rules/preview`, `POST /rules/extension-impact` |

Errors are `{ statusCode, message, code?, issues? }`. Special codes: `MFA_REQUIRED`, `DEVICE_WIPE`.
