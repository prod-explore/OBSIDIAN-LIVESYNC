# Build from the repository root (the dependencies are locked once, for the whole workspace):
#   docker build -f packages/mcp/Dockerfile .
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/gcal-sync/package.json packages/gcal-sync/
COPY packages/mcp/package.json packages/mcp/
RUN npm ci --workspace packages/mcp

COPY tsconfig.base.json ./
COPY packages/mcp/tsconfig.json packages/mcp/
COPY packages/mcp/src packages/mcp/src
RUN npm run build --workspace packages/mcp

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
COPY packages/gcal-sync/package.json packages/gcal-sync/
COPY packages/mcp/package.json packages/mcp/
RUN npm ci --workspace packages/mcp --omit=dev && npm cache clean --force

# The compiled tests are not part of the image.
COPY --from=builder /app/packages/mcp/dist packages/mcp/dist
RUN rm -rf packages/mcp/dist/__tests__

EXPOSE 3000

# Runs as the unprivileged "node" user. Compose also pins it to 1000:1000 so files written into
# the vault belong to the same user as headless Obsidian's.
USER node

WORKDIR /app/packages/mcp

# /mcp/health needs the key, which the container already has.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/mcp/health',{headers:{authorization:'Bearer '+process.env.MCP_API_KEY}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# node, not npm: npm would sit in between as PID 1 and swallow the SIGTERM the graceful shutdown waits for.
CMD ["node", "dist/index.js"]
