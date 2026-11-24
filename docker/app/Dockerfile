FROM node:24.18.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=buppancho-pnpm-v11,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir=/pnpm/store --fetch-timeout=600000 --network-concurrency=4

FROM base AS tools
COPY --from=deps /app/node_modules ./node_modules
COPY . .

FROM tools AS builder
ARG DATABASE_URL=postgresql://build:build@postgres:5432/build
ARG ALLOWED_ORIGINS=localhost:3000
ENV DATABASE_URL=$DATABASE_URL
ENV ALLOWED_ORIGINS=$ALLOWED_ORIGINS
RUN pnpm build

FROM node:24.18.0-bookworm-slim AS runner
ARG RELEASE_SHA=development
LABEL org.opencontainers.image.revision=$RELEASE_SHA
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
