# syntax=docker/dockerfile:1

# ============================================================
# Build stage — install deps, generate the Prisma client for
# the target platform (linux), compile TypeScript.
# ============================================================
FROM node:20-bookworm AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ============================================================
# Runtime stage — production deps only + build artifacts.
# The query engine from the build stage (linux binary) ships
# with node_modules/.prisma, so no network access is needed
# at runtime to talk to Postgres.
# ============================================================
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prisma's query engine links libssl on Linux.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libssl3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

# Migrations run automatically on every deploy/start, then the bot starts.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
