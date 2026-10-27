# PROGRESS

_Last session: 2026-10-27._ **Phase 1 complete.** Resume at Phase 2 in docs/ROADMAP.md (carry-overs first: reviewer audit, ESLint, teams).

## Test status — 138 tests, all green
| Package | Tests | Notes |
|---|---|---|
| `@worko/domain` | 15 | validators, money, FY, permissions incl. escalation guard (groups subset, hidden fields) |
| `@worko/rules` | 14 | golden due dates, holidays, extensions, versions |
| `@worko/sync` | 55 | 50 seeded convergence simulations |
| `@worko/api` | 28 | real Postgres: signup, login, lockout, OTP, TOTP (RFC vectors), refresh reuse, remote wipe, RLS isolation, audit tamper detection, permissions, contract (routes ≡ openapi.yaml), demo seed |
| `@worko/api-client` | 4 | refresh single-flight, wipe, sign-out |
| `@worko/ui-tokens` | 4 | WCAG AA contrast in both themes |
| `@worko/i18n` | 3 | interpolation, fallback, IST formatting |
| `@worko/web` | 6 | login + MFA step, lockout message, permission-hidden nav, Ctrl+K, remote wipe, offline banner |
| `@worko/desktop` | 7 | encrypted token store, link allow-list, renderer URL lock, IPC payload validation, tray |
| `@worko/mobile` | 2 | tabs, theme contrast; Android JS bundle built by `pnpm build` |

Also verified manually this session: API + web + headless Chromium end-to-end (demo login → palette → team → audit verify → security on phone width).

## Phase 1 review (reviewer subagent) — fixed
- `idempotency_key` lacked RLS → migration `0003_hardening` adds policy (+ test).
- TOTP: wrong codes now count toward lockout; time-step replay rejected (+ test).
- Phone OTP: new requests retire open challenges, 5 codes/hour cap, lockout honoured (+ test).
- Session revoke/wipe and user creation now check the target's branch and require covering all of the target's roles (+ test).
- Refresh: device id comes from the server-side session; disabled users can't refresh (+ test).
- Electron: renderer locked to the exact app URL (navigate/redirect/webview), every IPC handler checks the sender, token payloads validated (+ tests).
- Deferred with entries in KNOWN_GAPS: field-hiding on responses, sensitive-client storage, 2FA recovery, role editor, audit anchoring, web anti-framing headers.

## Phase 1 deliverables
- Migrations `0001_foundation`, `0002_auth` + runner; RLS via `worko_app` role per transaction.
- Auth: password + lockout, phone OTP, TOTP 2FA, rotating refresh with reuse detection, device list, remote logout, remote wipe.
- Global auth guard, `@Perm`, privilege-escalation guard, hash-chained audit log with verify.
- Firm signup, users, roles, demo seed.
- OpenAPI contract + generated client; web, desktop and mobile shells; ui-tokens; i18n.

## Next (Phase 2)
1. Carry-overs: reviewer audit of Phase 1, ESLint/Prettier, teams table.
2. `/sync/push` + `/sync/pull` on Postgres using `@worko/sync` semantics; WS change feed; SQLite stores (desktop better-sqlite3/SQLCipher, mobile op-sqlite).
3. Notification service: in-app inbox, desktop toasts with actions, FCM, Web Push; local reminder scheduler; quiet hours; escalation.
