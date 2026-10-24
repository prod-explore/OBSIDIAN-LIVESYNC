import * as fs from 'fs/promises';
import { loadConfig, type Config } from './config.js';
import { errorMessage } from './errors.js';
import { logger } from './logger.js';
import { createApp } from './server.js';

function start(config: Config): void {
  const { app } = createApp(config);

  const httpServer = app.listen(config.port, () => {
    logger.info('Obsidian MCP server listening', {
      port: config.port,
      endpoints: ['POST /mcp/sse (streamable HTTP)', 'GET /mcp/sse (legacy SSE)', 'GET /mcp/health'],
    });
    void ensureVault(config);
  });

  // A port that is taken (or not allowed) arrives here, not as an exception: say so in one line and stop.
  httpServer.on('error', (err) => {
    logger.error('Cannot listen', { port: config.port, error: errorMessage(err) });
    process.exit(1);
  });

  function shutdown(signal: string): void {
    logger.info('Shutting down', { signal });
    httpServer.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    // Force exit if connections don't close within 10s.
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function ensureVault(config: Config): Promise<void> {
  try {
    await fs.access(config.vaultResolved);
    logger.info('Vault found', { path: config.vaultResolved });
  } catch {
    logger.warn('Vault path does not exist yet; headless Obsidian creates it', { path: config.vaultResolved });
  }
}

try {
  start(loadConfig());
} catch (err) {
  logger.error('Cannot start', { error: errorMessage(err) });
  process.exit(1);
}
