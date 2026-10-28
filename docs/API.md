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
| Service catalogue | `GET/POST /service-types`, `PATCH /service-types/{id}`, `POST /service-types/install-defaults`, `GET /clients/{id}/services`, `PUT /clients/{id}/services/{serviceTypeId}` |
| Tasks | `GET/POST /tasks`, `GET /tasks/calendar`, `GET/PATCH /tasks/{id}`, `POST /tasks/{id}/checks|close`, `POST /tasks/bulk`, `/tasks/bulk/undo`, `POST /tasks/auto/preview|commit` |
| To-dos | `GET/POST /todos`, `PATCH/DELETE /todos/{id}`, `GET/POST /todo-templates`, `POST /todo-templates/{id}/apply` |
| Compliance | `GET/POST /compliance/packs`, `GET /compliance/packs/{id}/diff`, `POST /compliance/packs/{id}/approve`, `GET/POST /compliance/extensions`, `GET /compliance/extensions/{id}/impact`, `POST /compliance/extensions/{id}/approve`, `GET /compliance/matrix`, `POST /compliance/late-fee` (indicative) |
| Billing config | `GET/POST /billing/entities`, `PATCH /billing/entities/{id}`, `GET/PUT /billing/settings`, `GET/POST /billing/rates`, `PATCH /billing/rates/{id}`, `GET/PUT /billing/tally/ledgers` (writes: firm-wide `settings:edit`); `PATCH /service-types/{id}` takes `sacCode`, `gstRate`; `PUT /clients/{id}/services/{st}` takes `billingFrequency` (retainer) |
| Invoices | `GET/POST /billing/invoices`, `GET /billing/invoices/export`, `GET/PATCH/DELETE /billing/invoices/{id}` (drafts only), `POST /billing/invoices/{id}/issue|cancel|notes|follow-up|send|payment-link`, `GET /billing/invoices/{id}/pdf`, `POST /billing/auto/preview|commit`, `POST /billing/retainers/preview|commit` |
| Receipts & reports | `GET/POST /billing/receipts`, `GET /billing/receipts/export`, `GET /billing/receipts/{id}`, `POST /billing/receipts/{id}/apply`, `GET /billing/receipts/{id}/pdf`, `GET /billing/ageing`, `GET /billing/unbilled`, `GET /billing/clients/{id}/outstanding`, `POST /billing/follow-ups/run` |
| Tally | `POST /billing/tally/dry-run`, `POST /billing/tally/export` (firm-wide `billing:export`) |
| Public (billing) | `POST /billing/webhooks/{provider}/{tenantId}` (HMAC of raw body), `GET /billing/public/{token}` (signed 30-day invoice PDF link) |
| Time (M10) | `GET/POST /time/entries`, `GET/PATCH/DELETE /time/entries/{id}`, `POST /time/entries/decide`, `POST /time/entries/{id}/reverse`, `POST /time/timesheets/submit`, `GET /time/timer`, `POST /time/timer/start|stop`, `GET /activity/live` (task/client named only if visible), `GET /reports/job-pnl` (`reports:view`; cost null without cost visibility), `GET /reports/capacity` |
| HR config | `GET/PUT /hr/settings`, `GET/POST /hr/holidays`, `DELETE /hr/holidays/{id}`, `GET/POST /hr/office-locations`, `PATCH /hr/office-locations/{id}`, `GET/POST /hr/leave-types`, `PATCH /hr/leave-types/{id}`, `GET/PUT /hr/expense-categories`, `PUT /hr/capacity/{userId}` (writes firm-wide `hr:edit`); `GET/POST /hr/cost-rates`, `DELETE /hr/cost-rates/{id}` (sensitive, D87) |
| Attendance | `POST /hr/attendance/check-in|check-out`, `GET /hr/attendance`, `POST /hr/attendance/{id}/decide`, `GET /hr/attendance/report?month=`, `GET/POST /hr/attendance/regularisations`, `POST /hr/attendance/regularisations/{id}/decide` |
| Leave | `GET /hr/leave/balances`, `GET/POST /hr/leave/ledger`, `POST /hr/leave/accrue`, `POST /hr/leave/comp-off/run`, `GET/POST /hr/leave/requests`, `POST /hr/leave/requests/{id}/decide|cancel` |
| Expenses | `GET/POST /hr/expenses/claims`, `GET/PATCH /hr/expenses/claims/{id}`, `POST /hr/expenses/claims/{id}/submit|decide|pay`, `GET/POST /hr/expenses/advances`, `POST /hr/expenses/advances/{id}/decide|pay`, `GET /hr/expenses/reimbursable` (`billing:view`), `POST /hr/expenses/lines/{id}/link` (`billing:edit`) |
| Communication (M13) | `GET/PUT /comm/settings` (PUT firm-wide `settings:edit`), `GET/POST /comm/rates`, `GET /comm/usage?month=`, `GET/POST /comm/templates`, `PATCH /comm/templates/{id}`, `POST /comm/templates/{id}/submit|decide|render`, `GET/POST /comm/consents`, `POST /comm/messages`, `GET /comm/inbox`, `POST /comm/inbox/{id}/assign` (`communication:assign`), `GET/POST /comm/broadcasts`, `GET /comm/broadcasts/{id}`, `POST /comm/broadcasts/{id}/preview|send|approve|cancel`, `GET /comm/broadcasts/{id}/recipients|export`, `GET/POST /comm/connections`, `DELETE /comm/connections/{id}`, `POST /comm/connections/{id}/sync`, `GET /comm/oauth/callback` (public, state-bound), `GET/POST /comm/webhooks/{provider}/{tenantId}` (public, signed), `GET/POST /clients/{id}/timeline` |
| Team chat | `GET/POST /chat/channels`, `POST /chat/channels/{id}/members`, `GET/POST /chat/channels/{id}/messages`, `POST /chat/channels/{id}/read`, `PATCH/DELETE /chat/messages/{id}` (any staff user; client channels need the client) |
| Calendar & booking | `GET/POST /calendar/events`, `PATCH/DELETE /calendar/events/{id}`, `POST /calendar/events/{id}/respond`, `GET/POST /calendar/feeds`, `DELETE /calendar/feeds/{id}`, `GET /calendar/ics/{tenantId}/{token}` (public), `GET/POST /booking/pages`, `PATCH /booking/pages/{id}`, `GET /booking/appointments`, `POST /booking/appointments/{id}/link-client`; public + throttled: `GET/POST /book/{firm}/{slug}`, `GET /book/manage/{token}`, `POST /book/manage/{token}/reschedule|cancel` |
| Realtime | `GET /v1/realtime` (WebSocket; first message `{type:'auth', token}`; server sends `ready`, `changed{cursor}`, `revoked{wipe}`) |

Errors are `{ statusCode, message, code?, issues? }`. Task rule codes (400): `required_checks_pending`, `reviewer_required`, `pending_issue_required`, `act_by_after_due`, `task_closed`, `task_not_done`, `person_cannot_see_task:<field>`. Billing codes: 409 `invoice_immutable`, `invoice_not_draft`, `invoice_settled`, `credit_exceeds_balance`, `task_not_billable`, `task_already_billed`, `over_settled`, `entity_locked`, `retainer_exists`; 400 `over_allocated`, `tds_section_required`, `due_before_issue`, `tally_validation` (issues = unmapped ledgers); 401 `bad_signature` (webhook). Time/HR codes: 409 `timer_running`, `immutable`, `already_reversed`, `already_checked_in`, `leave_overlap`, `insufficient_balance`, `not_pending`, `already_billed`, `amount_mismatch`; 400 `future_date`, `client_mismatch`, `day_over_24h`, `over_limit`, `leave_type_not_applicable`; 403 `self_approval`, `cost_hidden`. Communication codes: 409 `template_in_use`, 403 `account_mismatch`, 400 `template_required_for_category`, `address_not_on_client`, 409 `opted_out`, `not_opted_in`, `over_cap`, `template_required`, `template_not_approved`, `no_address`, `provider_decides`, `no_recipients`, `slot_unavailable`, `not_changeable`, `oauth_failed`, `direct_fixed`; 400 `invalid_template` (issues), `missing_variables`, `bad_variables`, `edit_window_closed`, `member_cannot_view_client`, `too_long`, `invalid:mentions`, `invalid:attachment_doc_ids`; 403 `self_approval`. Special codes: `MFA_REQUIRED`, `DEVICE_WIPE`, `STEP_UP_REQUIRED`, `PASSWORD_REQUIRED` (share links). Invisible records return 404 (never 403) so existence isn't confirmed.
