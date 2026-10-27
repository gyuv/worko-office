# Known gaps

| Area | Gap | Plan |
|---|---|---|
| Rule pack | Seed due dates are UNVERIFIED sample data; ITR dates by form/category changed in 2026 and are not modelled precisely. | Verify each rule against notifications, set `verified`/`source`. |
| Rule engine | `event` frequency (AGM-relative AOC-4/MGT-7, DIR-3 KYC per DIN) not generated yet. | Phase 4: event triggers create due items. |
| Rule engine | JSON-Schema export for external editors not yet emitted (zod only). | zod-to-json-schema in Phase 4. |
| UDIN | Regex assumes 2-digit year + 6-digit membership + 10 alphanumerics. | VERIFY AGAINST OFFICIAL ICAI DOCS. |
| Sync | Simulator models a single entity type and permission filter; no clock-skew dimension needed (server-order LWW) but chaos/load tests pending. | Phase 2. |
| Providers | No external adapters implemented yet (all listed in INTEGRATIONS.md). | Per phase. |
| Lint | No ESLint/Prettier config yet; `pnpm lint` is a no-op. | Phase 2 start. |
| Teams | `team` scope grants resolve only via `ownerUserIds` — there is no teams table yet, so Managers see only their own items. | Phase 3 (staff directory). |
| Rate limiting | Throttler uses in-memory storage → per-instance limits. | Redis storage when BullMQ/Redis land (Phase 2). |
| SMS | Phone OTP uses `MockSmsProvider` (logs in dev). No DLT provider wired. | Needs DLT entity + templates (INTEGRATIONS.md). |
| KMS | Field encryption key is derived from `FIELD_ENCRYPTION_KEY`; no KMS envelope / per-tenant data keys yet. | Phase 3 with the credential vault. |
| Desktop | No tray icon asset (empty image), not code-signed, no installer; Electron run verified only by typecheck/unit tests (no display in CI). Windows toast actions (Open/Snooze/Done) pending. | Phase 2 (notifications) / Phase 12 (installers). |
| Android | JS bundle builds (`expo export`); native Gradle/AAB build and on-device run not yet verified. No offline banner (needs NetInfo) or biometric app lock yet. | Phase 2. |
| Client portal users | `app_user.kind` supports `client`, but portal login flow is not built. | Phase 9. |
| Super-admin | Signup is self-serve (disable with `ALLOW_SIGNUP=false`); no super-admin console yet. | Phase 12. |
| Field hiding | `role.hidden_fields` is stored, loaded and enforced in role-grant escalation checks, but no API response is filtered by it yet (no fee/password fields exist until Phase 3). | Response serializer that strips hidden fields, built with the client module (Phase 3). |
| Sensitive clients | `can()` honours `sensitive` + `allowedUserIds`, but there is no table/column or endpoint using it yet. | Client master (Phase 3). |
| 2FA lifecycle | No 2FA disable, recovery codes, or admin-enforced 2FA policy. | Phase 2 carry-over. |
| Role management | Only system roles are seeded; no create/edit-role API or role editor UI. | Settings (Phase 2/3). |
| Audit anchoring | Hash chain is verified on demand only; a DB superuser could rewrite the whole chain. | Scheduled verification + periodic external anchoring of the chain head (e.g. write-once object storage) in Phase 12. |
| Web headers | CSP `frame-ancestors` in a `<meta>` tag is ignored by browsers; anti-framing must come from HTTP headers on the web host. API already sends `X-Frame-Options: DENY`. | Static-host/CDN header config in deployment (Phase 12). |
