# Known gaps

| Area | Gap | Plan |
|---|---|---|
| Rule pack | Seed due dates are UNVERIFIED sample data; ITR dates by form/category changed in 2026 and are not modelled precisely. | Verify each rule against notifications, set `verified`/`source`. |
| Rule engine | `event` frequency (AGM-relative AOC-4/MGT-7, DIR-3 KYC per DIN) not generated yet. | Phase 4: event triggers create due items. |
| Rule engine | JSON-Schema export for external editors not yet emitted (zod only). | zod-to-json-schema in Phase 4. |
| UDIN | Regex assumes 2-digit year + 6-digit membership + 10 alphanumerics. | VERIFY AGAINST OFFICIAL ICAI DOCS. |
| Sync | Simulator models a single entity type and permission filter; no clock-skew dimension needed (server-order LWW) but chaos/load tests pending. | Phase 2. |
| Providers | No external adapters implemented yet (all listed in INTEGRATIONS.md). | Per phase. |
| Format | ESLint runs in CI; no Prettier/formatter config yet. | Add with the first large UI module. |
| Rate limiting | Throttler uses in-memory storage → per-instance limits. | Redis storage when the API runs on more than one node. |
| SMS | Phone OTP uses `MockSmsProvider` (logs in dev). No DLT provider wired. | Needs DLT entity + templates (INTEGRATIONS.md). |
| KMS | Field encryption key is derived from `FIELD_ENCRYPTION_KEY`; no KMS envelope / per-tenant data keys yet. | Phase 3 with the credential vault. |
| Desktop | No tray icon asset (empty image), not code-signed, no installer; Electron run verified only by typecheck/unit tests (no display in CI). Toasts have click-to-open but no action buttons (Snooze/Done need Windows `toastXml` + protocol activation). `app.setBadgeCount` has no effect on Windows (needs overlay icon). | Phase 12 (installers/polish). |
| Android | JS bundle builds (`expo export`); native Gradle/AAB build, SQLCipher open, exact-alarm persistence across reboot and FCM token registration are unverified on a device (need `google-services.json`). No biometric app lock yet. | Next session with a device/emulator. |
| Client portal users | `app_user.kind` supports `client`, but portal login flow is not built. | Phase 9. |
| Super-admin | Signup is self-serve (disable with `ALLOW_SIGNUP=false`); no super-admin console yet. | Phase 12. |
| Field hiding | `role.hidden_fields` is stored, loaded and enforced in role-grant escalation checks, but no API response is filtered by it yet (no fee/password fields exist until Phase 3). | Response serializer that strips hidden fields, built with the client module (Phase 3). |
| Sensitive clients | `can()` honours `sensitive` + `allowedUserIds`, but there is no table/column or endpoint using it yet. | Client master (Phase 3). |
| 2FA lifecycle | No 2FA disable, recovery codes, or admin-enforced 2FA policy. | Phase 2 carry-over. |
| Role management | Only system roles are seeded; no create/edit-role API or role editor UI. | Settings (Phase 2/3). |
| Audit anchoring | Hash chain is verified on demand only; a DB superuser could rewrite the whole chain. | Scheduled verification + periodic external anchoring of the chain head (e.g. write-once object storage) in Phase 12. |
| Web headers | CSP `frame-ancestors` in a `<meta>` tag is ignored by browsers; anti-framing must come from HTTP headers on the web host. API already sends `X-Frame-Options: DENY`. | Static-host/CDN header config in deployment (Phase 12). |
| Multi-node realtime | Realtime fan-out and job polling are in-process; a second API node would miss events. | Redis pub/sub behind `RealtimeService`; job queue is already multi-node safe (SKIP LOCKED). |
| FCM | `fcm` channel uses `MockPushProvider`; real FCM HTTP v1 adapter needs a Firebase service account. | INTEGRATIONS.md; // VERIFY AGAINST OFFICIAL DOCS. |
| Push content | Push payloads include title/body (may name a client). Web Push is end-to-end encrypted; FCM payloads are visible to Google. | Per-firm "content-free push" option before FCM goes live. |
| Cross-device OS tray | Reading on one device stops *future* pushes elsewhere and clears in-app badges, but an OS notification already shown on another device stays until dismissed. | Send a silent "dismiss" data message (FCM/Web Push) on read. |
| Staged initial sync | One global cursor; a first sync pulls everything in cursor order (with progress), not essentials-first. | Per-table priority pull when clients/tasks volume lands (Phase 3/4). |
| Sync revocation | Synced tables are user-owned or firm-wide today, so scope changes never revoke rows. Scope-based tables (clients by group/branch, sensitive clients) need "revoked" ids in pull. | Phase 3 with the client master. |
| Digests | Digest preference is stored; morning/evening summary sender not built. | With the Daily Office Digest agent (Phase 10) / email channel (Phase 7). |
| Escalation text | Escalation notification titles are generated in English server-side. | Move to i18n keys rendered client-side. |
| Load/chaos tests | Convergence proven by seeded simulators and real-API tests; no 100k-client/1M-task load test or chaos test yet. | Phase 12 hardening. |
| Duplicate alerts on one device | A device with push enabled can get both the server push and its own locally scheduled reminder for the same item. | Suppress local scheduling for items the device has a live push subscription for, or tag OS notifications by id so the second replaces the first. |
| Email/WhatsApp/SMS channels | Allowed in `notification_delivery.channel`, but no senders are wired to notifications yet. | Phase 7 (communication hub). |
| Dead-letter jobs | Jobs that exhaust retries are marked `dead_at` and logged; no admin view, alert or replay. | Settings → System health (Phase 12) + automation-failure notifications (Phase 10). |
| Sync housekeeping | `sync_mutation` (idempotency) and resolved `sync_conflict` rows are never pruned; `/sync/push` volume is only bounded by the global rate limit. | Retention job (e.g. 30 days) + per-device push quota. |
| Deactivation flow | Sockets and refresh now stop for disabled users, but there is no UI/API yet to deactivate a user. | Users module (Phase 3). |
