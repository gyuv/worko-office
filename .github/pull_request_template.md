## What changes for users

## How it was checked
- [ ] `pnpm typecheck` · `pnpm lint` · `pnpm test`
- [ ] New route → `docs/openapi.yaml` + regenerated client, `@Perm` set
- [ ] Every mutation writes an audit entry; no secrets in logs, audit or sync
- [ ] UI strings via `@worko/i18n`, colours via `@worko/ui-tokens`
- [ ] `PROGRESS.md` line added

## Screenshots (UI changes)
