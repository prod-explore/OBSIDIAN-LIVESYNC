import { loadConfig } from './config.js';
import { createApp } from './server.js';
import * as fs from 'fs/promises';

const config = loadConfig();

async function ensureVault(): Promise<void> {
  try {
    await fs.access(config.vaultResolved);
    console.log(`Vault path verified at ${config.vaultResolved}`);
  } catch {
    console.warn(`Vault path ${config.vaultResolved} does not exist yet. It will be created by headless Obsidian.`);
  }
}

const { app } = createApp(config);

const httpServer = app.listen(config.port, async () => {
  console.log(`Obsidian Headless MCP Server running on port ${config.port}`);
  console.log('Protocols: Streamable HTTP (POST /mcp/sse) + Legacy SSE (GET /mcp/sse)');
  await ensureVault();
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down gracefully...`);
  httpServer.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  // Force exit if connections don't close within 10s.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
