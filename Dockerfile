# ─── Stage 1: Install all dependencies ───────────────────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app

RUN npm install -g pnpm@10.26.2

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile


# ─── Stage 2: Generate Prisma client & compile TypeScript ─────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm@10.26.2

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm run db:generate && pnpm run build


# ─── Stage 3: Production runner ───────────────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /app

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# node_modules copied in full — pnpm's virtual store means the generated
# Prisma client lives inside .pnpm and cannot be cherry-picked safely
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules

# Compiled application
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist

# Prisma config — provides datasource.url (schema.prisma has no url field)
COPY --from=builder --chown=appuser:appgroup /app/prisma.config.ts ./prisma.config.ts

# Prisma schema — needed by migrate deploy at runtime
COPY --from=builder --chown=appuser:appgroup /app/prisma ./prisma

# tsconfig.json — required by ts-node (used in db:seed) to resolve CJS mode and path aliases
COPY --from=builder --chown=appuser:appgroup /app/tsconfig.json ./tsconfig.json

COPY --chown=appuser:appgroup entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

USER appuser

EXPOSE 4004

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/src/main"]
