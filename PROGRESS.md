# PROGRESS

_Last session: 2026-10-27._ **Phase 2 complete** (pending reviewer audit fixes, see below). Resume at Phase 3 in docs/ROADMAP.md.

## Test status — all green (lint clean, `--max-warnings=0`)
| Package | Tests | Notes |
|---|---|---|
| `@worko/domain` | 15 | validators, money, FY, permissions + escalation guard |
| `@worko/rules` | 14 | golden due dates, holidays, extensions, versions |
| `@worko/sync` | 85 | reference simulator (50 seeds); client engine with memory + SQLite stores, offline/reconnect, optimistic overlay, immediate revert on rejection, 20-seed engine convergence, SQLite restart durability, RealtimeClient |
| `@worko/notify` | 8 | IST quiet hours across midnight, delivery plan, backoff, reminder scheduler (snooze, restart, prime, OS pre-schedule) |
| `@worko/api` | 44 | real Postgres: auth suite, review regressions, sync push/pull/paging/permissions/merge+conflict restore/strict/commit-order, push delivery/retry/gone/quiet hours/critical, escalation (manager + team lead), realtime feed + live revoke, client engine ↔ API end-to-end, contract |
| `@worko/api-client` | 4 | refresh single-flight, wipe, sign-out |
| `@worko/web` | 9 | auth flows, palette, wipe, offline; synced inbox (badge, read/ack via outbox); encrypted IndexedDB store |
| `@worko/desktop` | 8 | token store, DB key (stable, encrypted, destroyed on wipe), renderer lock-down |
| `@worko/mobile` | 3 | tabs, theme, Android channel mapping; Android bundle builds |
| `@worko/ui-tokens`, `@worko/i18n` | 4 + 3 | |

Verified manually: two browser "devices" against the real API — new notification reached the other device via WebSocket in 84 ms; read on one cleared the other's badge in 82 ms; offline → reconnect → synced.

## Phase 2 deliverables
- Migration `0004`: teams, sync tables, notifications, prefs, push subscriptions, deliveries, job queue; commit-ordered cursors.
- Server sync (`/sync/*`) via registry; conflict log + restore; strict tables; realtime WebSocket with live revoke/wipe.
- Notifications: push delivery (Web Push real, FCM mock), retry/backoff, quiet hours, critical bypass, escalation with ack, read-anywhere dedupe, prefs, test send.
- Clients: web/desktop (encrypted IndexedDB, native toasts, badge, Web Push opt-in, sync indicator), Android (SQLCipher store, channels, exact-alarm reminders, offline banner, inbox).
- ESLint in CI; teams + team scope.

## Next (Phase 3)
Clients & contacts (GSTIN adapter, groups, import wizard, duplicates), credential vault + browser extension, documents, inward/outward registers — each as a synced registry table where devices need it offline.
