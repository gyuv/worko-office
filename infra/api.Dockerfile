# Production image for the NestJS API (docs/DEPLOY.md). Build from the repo root:
#   docker build -f infra/api.Dockerfile -t worko-api .
# Run migrations with the owner role:  docker run --rm -e DATABASE_URL=… worko-api node dist/db/migrate.js
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH ELECTRON_SKIP_BINARY_DOWNLOAD=1 TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@worko/api...
# Self-contained production tree: the api package + its runtime deps (workspace packages copied in, not linked).
RUN pnpm --filter @worko/api deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
