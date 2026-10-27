# PROGRESS

_Last session: 2026-10-27._ **Phase 1 complete.** Resume at Phase 2 in docs/ROADMAP.md (carry-overs first: reviewer audit, ESLint, teams).

## Test status — 130 tests, all green
| Package | Tests | Notes |
|---|---|---|
| `@worko/domain` | 14 | validators, money, FY, permissions incl. escalation guard |
| `@worko/rules` | 14 | golden due dates, holidays, extensions, versions |
| `@worko/sync` | 55 | 50 seeded convergence simulations |
| `@worko/api` | 23 | real Postgres: signup, login, lockout, OTP, TOTP (RFC vectors), refresh reuse, remote wipe, RLS isolation, audit tamper detection, permissions, contract (routes ≡ openapi.yaml), demo seed |
| `@worko/api-client` | 4 | refresh single-flight, wipe, sign-out |
| `@worko/ui-tokens` | 4 | WCAG AA contrast in both themes |
| `@worko/i18n` | 3 | interpolation, fallback, IST formatting |
| `@worko/web` | 6 | login + MFA step, lockout message, permission-hidden nav, Ctrl+K, remote wipe, offline banner |
| `@worko/desktop` | 5 | encrypted token store, link allow-list, tray |
| `@worko/mobile` | 2 | tabs, theme contrast; Android JS bundle built by `pnpm build` |

Also verified manually this session: API + web + headless Chromium end-to-end (demo login → palette → team → audit verify → security on phone width).

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
