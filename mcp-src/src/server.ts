import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as fs from 'fs/promises';
import { Config } from './config.js';
import { registerAllTools } from './tools/index.js';
import { tokensMatch } from './security.js';

function createMcpServer(config: Config): McpServer {
  const server = new McpServer({ name: 'Obsidian Headless MCP', version: '1.1.0' });
  registerAllTools(server, config);
  return server;
}

// ─── Auth ───────────────────────────────────────────────────────────────────

function extractToken(req: express.Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.split(' ')[1];

  const fromQuery = req.query.token;
  if (typeof fromQuery === 'string') return fromQuery;

  return undefined;
}

function requireAuth(config: Config, req: express.Request, res: express.Response): boolean {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Missing token' });
    return false;
  }
  if (!tokensMatch(token, config.apiKey)) {
    res.status(403).json({ error: 'Forbidden: Invalid API Key' });
    return false;
  }
  return true;
}

// ─── SSE session tracking (legacy transport) ───────────────────────────────

interface SseSession {
  transport: SSEServerTransport;
  server: McpServer;
  createdAt: number;
}

/**
 * Owns the legacy-SSE session map and sweeps it on a timer.
 *
 * Why the sweep exists: session cleanup normally happens on the response's
 * 'close' event, but that event isn't guaranteed to fire for every disconnect
 * (a phone sleeping mid-connection, a NAT/proxy dropping the socket silently,
 * etc.). Without a backstop, sessions like that live in this Map — and the
 * McpServer + transport objects they hold — forever, for the life of the
 * process. The sweep force-closes anything older than maxAgeMs so a build-up
 * of abandoned sessions can't slowly leak memory on a long-running deployment.
 */
class SseSessionRegistry {
  private sessions = new Map<string, SseSession>();
  private sweepHandle: NodeJS.Timeout | null = null;

  constructor(private maxAgeMs: number, private sweepIntervalMs: number) {}

  add(id: string, session: Omit<SseSession, 'createdAt'>): void {
    this.sessions.set(id, { ...session, createdAt: Date.now() });
  }

  get(id: string): SseSession | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  startSweeping(): void {
    this.sweepHandle = setInterval(() => this.sweepStale(), this.sweepIntervalMs);
    this.sweepHandle.unref();
  }

  stopSweeping(): void {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
  }

  private sweepStale(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > this.maxAgeMs) {
        console.warn(`Sweeping stale SSE session ${id} (no clean close after ${this.maxAgeMs}ms)`);
        session.transport.close().catch(() => {});
        session.server.close().catch(() => {});
        this.sessions.delete(id);
      }
    }
  }

  size(): number {
    return this.sessions.size;
  }
}

// ─── App factory ────────────────────────────────────────────────────────────

export function createApp(config: Config): { app: express.Express; sseRegistry: SseSessionRegistry } {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  const sseRegistry = new SseSessionRegistry(config.sseSessionMaxAgeMs, config.sseSweepIntervalMs);
  sseRegistry.startSweeping();

  // Prevent OAuth-aware clients from probing discovery endpoints and getting
  // confused by a 401 where they expect a clean "not supported" 404.
  app.get(/^\/\.well-known\/oauth-.*/, (_req, res) => res.status(404).end());

  // ── Streamable HTTP transport (Antigravity, Cursor, etc.) — stateless ──
  // Each POST spins up a fresh server+transport, handles the one request, tears down.
  app.post('/mcp/sse', async (req, res) => {
    if (!requireAuth(config, req, res)) return;

    try {
      const server = createMcpServer(config);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error('Streamable HTTP error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Legacy SSE transport (Claude Desktop) ──
  app.get('/mcp/sse', async (req, res) => {
    if (!requireAuth(config, req, res)) return;

    console.log('New SSE connection established');
    const transport = new SSEServerTransport('/mcp/messages', res);
    const connectionServer = createMcpServer(config);

    await connectionServer.connect(transport);
    sseRegistry.add(transport.sessionId, { transport, server: connectionServer });

    res.on('close', async () => {
      console.log(`SSE connection closed: ${transport.sessionId}`);
      sseRegistry.delete(transport.sessionId);
      try {
        await connectionServer.close();
      } catch {
        /* already closing */
      }
    });
  });

  app.post('/mcp/messages', async (req, res) => {
    const sessionId = req.query.sessionId;
    if (typeof sessionId !== 'string') {
      res.status(400).send('Missing or invalid sessionId');
      return;
    }

    const session = sseRegistry.get(sessionId);
    if (!session) {
      res.status(404).send('Session not found');
      return;
    }

    await session.transport.handlePostMessage(req, res, req.body);
  });

  // ── Health check ──
  app.get('/mcp/health', async (req, res) => {
    if (!requireAuth(config, req, res)) return;
    const vaultExists = await fs
      .access(config.vaultResolved)
      .then(() => true)
      .catch(() => false);
    res.json({
      status: 'ok',
      vaultPath: config.vaultResolved,
      vaultExists,
      activeSseSessions: sseRegistry.size(),
    });
  });

  return { app, sseRegistry };
}
