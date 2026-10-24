# Multi-stage Dockerfile for Payment Service
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/payment-service/ ./services/payment-service/

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @agentpay/contracts run build
RUN pnpm --filter @agentpay/config run build
RUN pnpm --filter @agentpay/logger run build
RUN pnpm --filter @agentpay/payment-service run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4003
ENV HOST=0.0.0.0

USER node

COPY --chown=node:node --from=builder /app/package.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/packages ./packages
COPY --chown=node:node --from=builder /app/services/payment-service ./services/payment-service

EXPOSE 4003

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4003/health || exit 1

CMD ["node", "services/payment-service/dist/index.js"]
