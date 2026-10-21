FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The compiled tests are not part of the image.
COPY --from=builder /app/dist ./dist
RUN rm -rf dist/__tests__

# Runs as the unprivileged "node" user; compose pins 1000:1000 to match headless Obsidian.
USER node

# node, not npm: npm would sit in between as PID 1 and swallow the SIGTERM the graceful shutdown waits for.
CMD ["node", "dist/index.js"]
