import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const VAULT_PATH = process.env.VAULT_PATH || '/vault';

const API_KEY = process.env.MCP_API_KEY;
if (!API_KEY) {
  console.error('FATAL: MCP_API_KEY environment variable is not set. Refusing to start.');
  process.exit(1);
}

// ─── Startup check ────────────────────────────────────────────────────────────

async function ensureVault(): Promise<void> {
  try {
    await fs.access(VAULT_PATH);
    console.log(`Vault path verified at ${VAULT_PATH}`);
  } catch {
    console.warn(`Vault path ${VAULT_PATH} does not exist yet. It will be created by headless Obsidian.`);
  }
}

// ─── Path safety ──────────────────────────────────────────────────────────────

const VAULT_RESOLVED = path.resolve(VAULT_PATH);

function resolveVaultPath(relativePath: string): string {
  const resolved = path.resolve(VAULT_RESOLVED, relativePath);
  if (!resolved.startsWith(VAULT_RESOLVED + path.sep) && resolved !== VAULT_RESOLVED) {
    throw new Error('Security Error: Path traversal attempt detected.');
  }
  return resolved;
}

// ─── MCP Server Factory ───────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'Obsidian Headless MCP',
    version: '1.0.0',
  });



  // Tool: read_note
  server.tool(
    'read_note',
    'Reads the content of a markdown note from the Obsidian vault.',
    {
      path: z.string().describe('Path to the note relative to the vault root (e.g., "Folder/My Note.md")'),
    },
    async ({ path: notePath }) => {
      try {
        const fullPath = resolveVaultPath(notePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        return { content: [{ type: 'text', text: content }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error reading note: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: write_note
  server.tool(
    'write_note',
    'Writes or overwrites a markdown note in the Obsidian vault.',
    {
      path: z.string().describe('Path to the note relative to the vault root (e.g., "Folder/My Note.md")'),
      content: z.string().describe('The markdown content to write to the note'),
    },
    async ({ path: notePath, content }) => {
      try {
        const fullPath = resolveVaultPath(notePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
        return { content: [{ type: 'text', text: `Successfully wrote note to ${notePath}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error writing note: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: search_notes
  server.tool(
    'search_notes',
    'Searches for notes containing a specific keyword or phrase.',
    {
      query: z.string().describe('The keyword or phrase to search for'),
    },
    async ({ query }) => {
      try {
        const results: string[] = [];

        async function walkDir(dir: string) {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.resolve(dir, entry.name);
            if (entry.isDirectory()) {
              await walkDir(full);
            } else if (entry.name.endsWith('.md')) {
              try {
                const content = await fs.readFile(full, 'utf-8');
                const q = query.toLowerCase();
                if (content.toLowerCase().includes(q) || entry.name.toLowerCase().includes(q)) {
                  results.push(path.relative(VAULT_RESOLVED, full));
                }
              } catch {
                // ignore unreadable files
              }
            }
          }
        }

        await walkDir(VAULT_RESOLVED);

        return {
          content: [{
            type: 'text',
            text: results.length > 0
              ? `Found ${results.length} notes matching "${query}":\n\n${results.join('\n')}`
              : `No notes found matching "${query}".`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error searching notes: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function extractToken(req: express.Request): string | undefined {
  // Prefer Authorization header; fall back to ?token= query param
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.split(' ')[1];

  const fromQuery = req.query.token;
  if (typeof fromQuery === 'string') return fromQuery;

  return undefined;
}

function requireAuth(req: express.Request, res: express.Response): boolean {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Missing token' });
    return false;
  }
  if (token !== API_KEY) {
    res.status(403).json({ error: 'Forbidden: Invalid API Key' });
    return false;
  }
  return true;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// ─── Streamable HTTP transport (new protocol — Antigravity, Cursor, etc.) ─────
// Stateless: each POST creates a fresh server+transport, handles, then cleans up.

app.post('/mcp/sse', async (req, res) => {
  if (!requireAuth(req, res)) return;

  try {
    const server = createMcpServer();
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

// ─── Legacy SSE transport (old protocol — Claude Desktop) ─────────────────────

interface SseSession {
  transport: SSEServerTransport;
  server: McpServer;
}
const sseSessions = new Map<string, SseSession>();

app.get('/mcp/sse', async (req, res) => {
  if (!requireAuth(req, res)) return;

  console.log('New SSE connection established');
  const transport = new SSEServerTransport('/mcp/messages', res);
  const connectionServer = createMcpServer();

  await connectionServer.connect(transport);
  sseSessions.set(transport.sessionId, { transport, server: connectionServer });

  res.on('close', async () => {
    console.log(`SSE connection closed: ${transport.sessionId}`);
    sseSessions.delete(transport.sessionId);
    try { await connectionServer.close(); } catch {}
  });
});

app.post('/mcp/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  if (typeof sessionId !== 'string') {
    res.status(400).send('Missing or invalid sessionId');
    return;
  }

  const session = sseSessions.get(sessionId);
  if (!session) {
    res.status(404).send('Session not found');
    return;
  }

  await session.transport.handlePostMessage(req, res, req.body);
});

// ─── Health check (authenticated) ────────────────────────────────────────────

app.get('/mcp/health', (req, res) => {
  if (!requireAuth(req, res)) return;
  res.json({ status: 'ok' });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

const httpServer = app.listen(PORT, async () => {
  console.log(`Obsidian Headless MCP Server running on port ${PORT}`);
  console.log(`Protocols: Streamable HTTP (POST /mcp/sse) + Legacy SSE (GET /mcp/sse)`);
  await ensureVault();
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  httpServer.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  // Force exit if connections don't close within 10s
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
