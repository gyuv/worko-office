# Worko

Worko is practice and office management software for Indian CA/CS firms. One NestJS backend serves four apps:

- a web app
- an Electron desktop app
- an Android app
- a client portal, branded with the firm's own name and logo

The apps stay in sync, and the desktop and Android apps keep working offline.

> **Status:** all roadmap phases (0–12) are built, but Worko is not ready for production yet. Before going live, work
> through [docs/RELEASE.md](docs/RELEASE.md) and [docs/KNOWN_GAPS.md](docs/KNOWN_GAPS.md). Several third-party
> adapters, statutory data packs and legal time periods are **samples marked UNVERIFIED** and must be checked against
> official sources.

## What it does
| Area | Highlights |
|---|---|
| Clients & documents | Client records with GSTIN/PAN validation, client groups, rules for who can see which client, and encrypted personal data.<br>Document store with versions, share links and inward/outward registers.<br>Credential vault, plus a browser extension that fills in logins on official government portals. |
| Tasks & compliance | Service catalogue, and tasks created automatically from the compliance rule packs.<br>Checklists and review before a task is done; audit tasks need a UDIN before they can close.<br>Compliance matrix and due-date extensions. |
| Billing & collections | GST invoices (CGST/SGST/IGST), credit and debit notes, receipts with TDS.<br>Ageing, automatic invoice drafts, payment reminders, payment links.<br>Export to Tally (XML). |
| Time & HR | Timers, timesheets, cost rates, job profit and loss, staff capacity.<br>Attendance by location or office network, leave ledger, expenses. |
| Communication | Email, WhatsApp and SMS that respect client consent and quiet hours.<br>Broadcasts, a timeline per client, team chat, calendar feeds (ICS), booking pages. |
| Practice | Notices and hearings, audit programmes and sign-offs, document request lists (PBC), UDIN recording.<br>DSC register, licences, e-signature. |
| Client portal & CRM | Clients log in with a one-time code and see only what they've been granted; they can upload, answer requests and pay.<br>Leads pipeline, versioned proposals, online acceptance, conversion into a client. |
| Automation & AI | Rules (trigger → conditions → actions), prebuilt agents, dry runs.<br>AI is off by default; when enabled, personal data is redacted and every AI suggestion needs a person's approval. |
| Reports | Report catalogue and builder, dashboards, drill-down, exports, scheduled reports, questions in plain language. |
| Platform | Super-admin console, SaaS plans and seat limits, support access only with the firm's consent.<br>DPDP (data protection) tools, public API keys, signed webhooks. |

## Quick start (development)
You need Node 22, pnpm 10, and Docker (or a local Postgres 16).
```bash
pnpm install
docker compose up -d                 # Postgres 16, Redis, MinIO, Mailpit
cp .env.example .env
pnpm --filter @worko/api migrate
pnpm seed:demo                       # demo firm "demo", password Demo@12345 (prints the other demo logins)
pnpm dev                             # API on :3000, web on :5173
```
- **Other apps:** `pnpm desktop:dev` for the Electron app, `pnpm mobile:dev` for the Expo/Android app.
- **Checks:** `pnpm build && pnpm typecheck && pnpm lint && TEST_DATABASE_URL=postgres://… pnpm test`.

The demo logins the seed prints (portal users, the platform admin, an API key) are **for development only**. Never
deploy them.

## Repository layout
| Path | Contents |
|---|---|
| `apps/api` | NestJS API, SQL migrations (`db/`), integration and end-to-end tests (`test/`) |
| `apps/web` | Vite React app, also used as the desktop app's interface and as the client portal |
| `apps/desktop` | Electron main process and installer config (`electron-builder.yml`) |
| `apps/mobile` | Expo Android app (staff mode and client-portal mode) with its EAS build config |
| `apps/extension` | Browser extension (Manifest V3) that fills portal logins from the vault |
| `packages/*` | Shared domain logic, compliance rules, sync engine, notifications, generated API client, translations, UI design tokens |
| `scripts/` | Backup, restore and restore drill (`dr/`), browser smoke test (`e2e/`), secrets scan |
| `docs/` | Specs, decisions, known gaps, API and data model, user manual, release and disaster-recovery guides |

## Documentation
- **For firms using Worko:**
  - [User manual](docs/manual/README.md): getting started, daily work for each role, each module, admin, troubleshooting, glossary.
- **For deploying and releasing:**
  - [Release checklist](docs/RELEASE.md)
  - [Disaster recovery](docs/DR.md)
  - [Release notes](docs/releases/) (also on the repository's GitHub Releases page)
- **For developers:**
  - Product: [PRD](docs/PRD.md), [Roadmap](docs/ROADMAP.md), [Progress](PROGRESS.md)
  - Design: [Decisions](docs/DECISIONS.md), [Known gaps](docs/KNOWN_GAPS.md)
  - API: [API guide](docs/API.md), [OpenAPI spec](docs/openapi.yaml), [Data model](docs/DATA_MODEL.md), [Integrations](docs/INTEGRATIONS.md)
  - Conventions: [CLAUDE.md](CLAUDE.md)
