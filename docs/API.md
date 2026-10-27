# API

Contract: `docs/openapi.yaml` (OpenAPI 3.1). REST under `/v1`, JSON, zod-validated, errors `{ message, issues[] }`.
Typed client `@worko/api-client` is generated from it (`pnpm --filter @worko/api-client generate`); CI fails if it is stale, and `apps/api/test/contract.int.test.ts` fails if routes and spec differ.

## Conventions
- Auth: `Authorization: Bearer <access>`; refresh via `POST /auth/refresh` (rotation, reuse detection kills the family).
- Idempotency: all POST/PATCH will accept `Idempotency-Key` (table exists; middleware lands with the first business mutations in Phase 2/3).
- Pagination: cursor-based `?after=&limit=`. Filtering via saved-view definitions, never raw SQL.
- Sync: `POST /sync/push`, `GET /sync/pull?since=`; WS `/v1/realtime` emits `{type:'changed', cursor}` hints.
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
| Sync | `POST /sync/push`, `GET /sync/pull`, `GET /sync/conflicts`, `POST /sync/conflicts/{id}/resolve` |
| Notifications | `GET /notifications`, `/notifications/unread-count`, `POST /notifications/{id}/read|ack|snooze`, `/notifications/read-all`, `/notifications/test`, `GET/PUT /notifications/prefs` |
| Push | `POST /push/subscriptions`, `DELETE /push/subscriptions/{id}`, `GET /push/vapid-public-key` |
| Teams | `GET/POST /teams`, `PUT /teams/{id}/members` |
| Clients | `GET/POST /clients`, `GET/PATCH/DELETE /clients/{id}`, `PUT /clients/{id}/access`, `POST /clients/{id}/merge|reveal|registrations|contacts`, `POST /clients/duplicates`, `POST /clients/import/preview|commit`, `GET /clients/export`, `GET /lookup/gstin/{gstin}`, `GET/POST /client-groups`, `GET/POST /custom-fields` |
| Vault | `GET /vault/secrets`, `POST /clients/{id}/secrets`, `PATCH/DELETE /vault/secrets/{id}`, `POST /vault/secrets/{id}/reveal`, `POST /vault/extension/pair-code`, `POST /auth/extension/pair`, `POST /auth/step-up` |
| Documents | `GET/POST /documents`, `PATCH/DELETE /documents/{id}`, `POST /documents/{id}/restore|download-url|shares`, `GET /documents/{id}/versions|access-log|shares`, `DELETE /shares/{id}`, `GET /clients/{id}/document-tree`, public `GET /files/{token}`, `GET|POST /share/{token}` |
| Registers | `GET/POST /registers/{inward|outward}`, `PATCH /registers/{kind}/{id}`, `POST /registers/{kind}/{id}/signature`, `GET /registers/{kind}/{id}/receipt.pdf` |
| Users | `PATCH /users/{id}` (deactivate, manager, branch, roles) |
| Realtime | `GET /v1/realtime` (WebSocket; first message `{type:'auth', token}`; server sends `ready`, `changed{cursor}`, `revoked{wipe}`) |

Errors are `{ statusCode, message, code?, issues? }`. Special codes: `MFA_REQUIRED`, `DEVICE_WIPE`, `STEP_UP_REQUIRED`, `PASSWORD_REQUIRED` (share links). Invisible records return 404 (never 403) so existence isn't confirmed.
