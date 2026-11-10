# Contributing to Worko

## Get running (5 minutes)
```bash
pnpm install
docker compose up -d
cp .env.example .env
pnpm --filter @worko/api migrate && pnpm seed:demo
pnpm dev            # API :3000 · web :5173
```

## Before you open a pull request
```bash
pnpm typecheck && pnpm lint && pnpm test
```
- Follow the conventions in [CLAUDE.md](CLAUDE.md): money in paise, dates in IST, zod on every input, audit every mutation.
- New API route → update `docs/openapi.yaml`, then `pnpm --filter @worko/api-client generate`.
- UI text goes in `packages/i18n`; colours come from `packages/ui-tokens`.
- Add a line to `PROGRESS.md`.

## Releasing
Run **Actions → Release builds** with `release_tag` (e.g. `v1.3.0`). Windows, macOS and Android installers are built and published,
and every installed app updates itself on its next start. See [docs/RELEASE.md](docs/RELEASE.md).
