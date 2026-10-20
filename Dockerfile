# syntax=docker/dockerfile:1

# ---- Toolchain for native modules (better-sqlite3) ----
FROM node:24-slim AS toolchain
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- Build web app and server bundle ----
FROM toolchain AS build
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/
COPY packages/shared/package.json packages/shared/
RUN npm ci
COPY . .
RUN npm run build

# ---- Production dependencies of the server only ----
FROM toolchain AS deps
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --workspace @nicotes/server --include-workspace-root=false

# ---- Runtime ----
FROM node:24-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    NICOTES_BACKUP_DIR=/backups \
    NICOTES_PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node
VOLUME ["/data", "/backups"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.NICOTES_PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
