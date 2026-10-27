/**
 * The HTTP side of the MCP server: token authentication, the two MCP transports (stateless streamable HTTP and the
 * legacy SSE transport with its session registry), the health endpoint and the JSON answer to a bad request body.
 */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as fs from 'fs/promises';
import { createRequire } from 'module';
import { Config } from './config.js';
import { errorMessage } from './errors.js';
import { logger } from './logger.js';
import { registerAllTools } from './tools/index.js';
import { tokensMatch } from './security.js';
import { WriteLimiter } from './rateLimit.js';

/** What clients see in `serverInfo`: the package's own version, so the two cannot drift apart. */
export const SERVER_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

function createMcpServer(config: Config, limiter: WriteLimiter): McpServer {
  const server = new McpServer(
    { name: 'Obsidian Headless MCP', version: SERVER_VERSION },
    config.instructions ? { instructions: config.instructions } : {},
  );
  registerAllTools(server, config, limiter);
  return server;
}

/** The token from `Authorization: Bearer …`, or from `?token=` for clients that cannot set a header. */
function extractToken(req: express.Request): { token: string; fromQuery: boolean } | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return { token: authHeader.split(' ')[1], fromQuery: false };

  const fromQuery = req.query.token;
  if (typeof fromQuery === 'string') return { token: fromQuery, fromQuery: true };

  return undefined;
}

/**
 * Does the token match the key? A query string decodes an unencoded `+` to a space, so a base64 key pasted into a URL
 * as it is arrives with spaces where it had `+`. A key never has both, so a query token with spaces is also tried
 * with `+` in their place; the token as received is tried first, which keeps a key that really holds a space working.
 */
function tokenMatchesKey(token: string, fromQuery: boolean, apiKey: string): boolean {
  if (tokensMatch(token, apiKey)) return true;
  return fromQuery && token.includes(' ') && tokensMatch(token.replaceAll(' ', '+'), apiKey);
}

function requireAuth(config: Config, req: express.Request, res: express.Response): boolean {
  const supplied = extractToken(req);
  // req.path has no query string, so the token (which may arrive as ?token=) is never part of what is logged.
  if (!supplied) {
    logger.warn('Rejected a request: no token', { status: 401, method: req.method, path: req.path });
    res.status(401).json({ error: 'Unauthorized: Missing token' });
    return false;
  }
  if (!tokenMatchesKey(supplied.token, supplied.fromQuery, config.apiKey)) {
    logger.warn('Rejected a request: wrong token', { status: 403, method: req.method, path: req.path });
    res.status(403).json({ error: 'Forbidden: Invalid API Key' });
    return false;
  }
  return true;
}

interface SseSession {
  transport: SSEServerTransport;
  server: McpServer;
  createdAt: number;
}

/**
 * Owns the legacy-SSE session map and sweeps it on a timer.
 *
 * A session is normally removed on the response's 'close' event, but that event does not fire for every
 * disconnect (a phone that sleeps mid-connection, a NAT or proxy that drops the socket silently). Such a session,
 * with the McpServer and transport it holds, would otherwise stay in the map for the life of the process; the
 * sweep closes every session older than `maxAgeMs`.
 */
class SseSessionRegistry {
  private sessions = new Map<string, SseSession>();
  private sweepHandle: NodeJS.Timeout | null = null;

  constructor(
    private maxAgeMs: number,
    private sweepIntervalMs: number,
  ) {}

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
        logger.warn('Closing a stale SSE session (no clean close)', { session: id, afterMs: this.maxAgeMs });
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

/**
 * Express 4 ignores the promise an async handler returns, so a rejection would be an unhandled rejection, and
 * Node ends the process on those. Every async route goes through here: the failure is logged and answered with a 500.
 */
function handle(
  route: string,
  fn: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      logger.error('Request failed', { route, error: errorMessage(err) });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    });
  };
}

/**
 * Builds the Express app with every route. The SSE registry is returned as well so a caller that does not run the
 * app for the life of the process (the tests) can stop its sweep timer.
 */
export function createApp(config: Config): { app: express.Express; sseRegistry: SseSessionRegistry } {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.bodyLimit }));
  // One limiter for every per-request server: the limit is on the vault, not on one connection.
  const writeLimiter = new WriteLimiter(config.writeLimit.max, config.writeLimit.windowMs);

  const sseRegistry = new SseSessionRegistry(config.sseSessionMaxAgeMs, config.sseSweepIntervalMs);
  sseRegistry.startSweeping();

  // OAuth-aware clients probe these discovery endpoints; a plain, empty 404 tells them this server does no OAuth.
  app.get(/^\/\.well-known\/oauth-.*/, (_req, res) => res.status(404).end());

  // Streamable HTTP, stateless: every POST gets its own server and transport, which are closed with the response.
  app.post(
    '/mcp/sse',
    handle('POST /mcp/sse', async (req, res) => {
      if (!requireAuth(config, req, res)) return;

      try {
        const server = createMcpServer(config, writeLimiter);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

        res.on('close', () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        logger.error('Streamable HTTP request failed', { error: errorMessage(err) });
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
      }
    }),
  );

  // Legacy SSE: the GET opens the stream, and the client posts its messages to /mcp/messages with the session id.
  // Both requests carry the token: the session id alone is never accepted as proof of identity.
  app.get(
    '/mcp/sse',
    handle('GET /mcp/sse', async (req, res) => {
      if (!requireAuth(config, req, res)) return;

      // A client that authenticated with ?token= cannot send a header, and the legacy SSE client posts to exactly the
      // endpoint announced here. Announcing the endpoint with the token keeps such clients working; the value only
      // travels inside the stream the same token just opened.
      const queryToken = req.query.token;
      const endpoint =
        typeof queryToken === 'string' && !req.headers.authorization
          ? `/mcp/messages?token=${encodeURIComponent(queryToken)}`
          : '/mcp/messages';
      const transport = new SSEServerTransport(endpoint, res);
      const connectionServer = createMcpServer(config, writeLimiter);

      await connectionServer.connect(transport);
      sseRegistry.add(transport.sessionId, { transport, server: connectionServer });
      logger.info('SSE connection opened', { session: transport.sessionId, active: sseRegistry.size() });

      res.on('close', () => {
        sseRegistry.delete(transport.sessionId);
        logger.info('SSE connection closed', { session: transport.sessionId, active: sseRegistry.size() });
        connectionServer.close().catch(() => {
          /* already closing */
        });
      });
    }),
  );

  app.post(
    '/mcp/messages',
    handle('POST /mcp/messages', async (req, res) => {
      if (!requireAuth(config, req, res)) return;

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
    }),
  );

  app.get(
    '/mcp/health',
    handle('GET /mcp/health', async (req, res) => {
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
    }),
  );

  // express.json() rejects a malformed or oversized body before any route (or the token check) runs. Express's own
  // handler would print a stack trace that can quote the body; this one logs the kind of failure and answers in JSON.
  const bodyErrors: express.ErrorRequestHandler = (err: unknown, req, res, next) => {
    if (res.headersSent) return next(err);
    const { status, type } = (typeof err === 'object' && err !== null ? err : {}) as {
      status?: unknown;
      type?: unknown;
    };
    const code = typeof status === 'number' && status >= 400 && status < 500 ? status : 500;
    if (code === 500) logger.error('Request failed', { method: req.method, path: req.path, error: errorMessage(err) });
    else logger.warn('Rejected a request body', { status: code, method: req.method, path: req.path, type });
    res.status(code).json({ error: code === 500 ? 'Internal server error' : 'Bad request body' });
  };
  app.use(bodyErrors);

  return { app, sseRegistry };
}
