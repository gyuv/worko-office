# Security policy

Worko holds client data for CA/CS firms, so we take reports seriously.

## Reporting a vulnerability
- **Privately** via [GitHub Security Advisories](https://github.com/gyuv/worko-office/security/advisories/new). Please do **not** open a public issue.
- Include steps to reproduce, the affected app (web, desktop, Android, portal, API) and version (*Appearance → About & updates*).
- Never include real client data, passwords or keys.

We aim to acknowledge reports within 3 working days and to share a fix plan within 10.

## Supported versions
Only the latest release receives fixes. Installed apps update themselves at start-up, so most users get fixes automatically.

## How Worko protects data (summary)
- Per-firm isolation with Postgres row-level security; every change audited on a hash-chained log.
- Secrets and personal data encrypted per firm (envelope keys); reveals need step-up auth and are audited.
- In-app updates download only from this repository's releases and verify SHA-256 before installing.
- Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DECISIONS.md](docs/DECISIONS.md).
