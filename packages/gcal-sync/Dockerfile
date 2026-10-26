# Build from the repository root (the dependencies are locked once, for the whole workspace):
#   docker build -f packages/gcal-sync/Dockerfile .
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/gcal-sync/package.json packages/gcal-sync/
COPY packages/mcp/package.json packages/mcp/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspace packages/gcal-sync --workspace packages/shared

COPY tsconfig.base.json ./
# The settings both services share (obsidian-livesync-shared) are built first, by the package's build script.
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/gcal-sync/tsconfig.json packages/gcal-sync/
COPY packages/gcal-sync/src packages/gcal-sync/src
RUN npm run build --workspace packages/gcal-sync

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/gcal-sync/package.json packages/gcal-sync/
COPY packages/mcp/package.json packages/mcp/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspace packages/gcal-sync --omit=dev && npm cache clean --force

# The compiled tests are not part of the image.
COPY --from=builder /app/packages/gcal-sync/dist packages/gcal-sync/dist
COPY --from=builder /app/packages/shared/dist packages/shared/dist
RUN rm -rf packages/gcal-sync/dist/__tests__ packages/shared/dist/__tests__

# Runs as the unprivileged "node" user; compose pins 1000:1000 to match headless Obsidian.
USER node

WORKDIR /app/packages/gcal-sync

# Healthy while a sync cycle has succeeded recently (see docs/operations.md).
HEALTHCHECK --interval=60s --timeout=10s --start-period=2m --retries=2 \
  CMD ["node", "dist/healthcheck.js"]

# node, not npm: npm would sit in between as PID 1 and swallow the SIGTERM the graceful shutdown waits for.
CMD ["node", "dist/index.js"]
