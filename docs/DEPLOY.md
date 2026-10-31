# Deploying Worko

Three pieces: the **API** (NestJS, `apps/api`), **Postgres 16** (+ object storage), and the **web app / client portal**
(static SPA, `apps/web`). Desktop and Android installers point at the API (docs/RELEASE.md §5a).

## Can it run on Vercel?
**Only the web app/portal.** `apps/web` is a static Vite SPA — Vercel (or any CDN: Netlify, Cloudflare Pages, S3+CloudFront)
hosts it well. **The API cannot run on Vercel.** It is a long-running Node server that needs:
- persistent **WebSockets** (`/v1/realtime` for live sync and chat) — Vercel Functions cannot hold them;
- **background workers**: the Postgres job queue (`src/jobs`), automation ticks, daily practice/SaaS/leave jobs,
  broadcasts, webhook retries with backoff, scheduled reports — nothing runs between requests on serverless;
- long requests (report exports, big uploads) beyond function time limits, and an in-process rate limiter;
- Postgres 16 with RLS roles (`worko_app`) + object storage (S3/MinIO) for documents.

## Recommended layout
| Piece | Options |
|---|---|
| API (container, ≥ 1 instance always on; 2 for rolling restarts) | Render (web service, Docker), Railway, Fly.io, AWS ECS/App Runner, Google Cloud Run **with min-instances ≥ 1 and CPU always allocated**, or any VPS with Docker |
| Postgres 16 | Neon, Supabase, AWS RDS/Aurora (ap-south-1 for India residency), DigitalOcean/Render managed Postgres. Needs a role that can create `worko_app` + RLS (run migrations as owner) |
| Object storage | AWS S3 (ap-south-1), Cloudflare R2, any S3-compatible (`STORAGE=s3`, `S3_*`) |
| Web / portal | Vercel (`apps/web/vercel.json`), or the same CDN as above |

### API image
`infra/api.Dockerfile` (multi-stage, `pnpm deploy --prod`, runs as `node`, health check `/v1/health`):
```bash
docker build -f infra/api.Dockerfile -t worko-api .
docker run --rm --env-file prod.env worko-api node dist/db/migrate.js      # owner-role DATABASE_URL, once per release
docker run -d -p 3000:3000 --env-file prod.env worko-api
```
Environment variables: docs/RELEASE.md §4. At minimum for a split-origin setup:
- `CORS_ORIGINS=https://app.example.in` (the Vercel domain, exact origin, comma-separated if several);
- `WEB_PUBLIC_URL=https://app.example.in`, `PORTAL_PUBLIC_URL=https://app.example.in/#/portal`,
  `PUBLIC_API_URL=https://api.example.in/v1`, `TRUST_PROXY=1` behind the platform's load balancer.

### Web on Vercel
1. New project → import the repo → **Root Directory `apps/web`** (Vercel detects the pnpm workspace and installs at the
   repo root; `vercel.json` builds the web app and its workspace deps with turbo, output `dist`).
2. Environment variable **`VITE_API_URL=https://api.example.in/v1`** (build-time). The SPA calls that API, and the
   build adds its origin (`https://` + `wss://`) to the CSP `connect-src` in `index.html` (`apps/web/vite.config.ts`).
   Without it the SPA calls `/v1` on its own origin (only works behind a reverse proxy that forwards `/v1` to the API).
3. Add the Vercel domain to the API's `CORS_ORIGINS`. Serve `/.well-known/assetlinks.json` from `apps/web/public/`
   if you use Android App Links.

The headers in `vercel.json` (HSTS, nosniff, frame deny, referrer, COOP) complement the CSP meta tag; `/assets/*`
are immutable (Vite hashes), `index.html` is `no-cache`.

> Not verified here: an actual Vercel deployment and the API on any of the hosts above (the Docker image was built
> and served `/v1/health` locally).
