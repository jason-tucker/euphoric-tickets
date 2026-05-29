FROM node:24-alpine AS builder

RUN corepack enable pnpm

WORKDIR /build

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN node --max-old-space-size=4096 node_modules/typescript/bin/tsc

FROM node:24-alpine AS production

WORKDIR /app

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

COPY drizzle.docker.config.cjs ./drizzle.docker.config.cjs

COPY scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production

ENTRYPOINT ["./docker-entrypoint.sh"]
