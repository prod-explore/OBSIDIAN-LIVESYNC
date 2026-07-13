import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

// Configuration
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.MCP_API_KEY || 'default_secret_key_change_me';
const VAULT_PATH = process.env.VAULT_PATH || '/vault';

// Ensure vault path exists
async function ensureVault() {
  try {
    await fs.access(VAULT_PATH);
    console.log(`Vault path verified at ${VAULT_PATH}`);
  } catch {
    console.warn(`Vault path ${VAULT_PATH} does not exist yet. It will be created by the headless Obsidian.`);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// Utility to safely resolve paths inside the vault
function resolveVaultPath(relativePath: string): string {
  // Bulletproof directory traversal prevention
  const resolvedPath = path.resolve(VAULT_PATH, relativePath);
  if (!resolvedPath.startsWith(path.resolve(VAULT_PATH))) {
    throw new Error('Security Error: Path traversal attempt detected.');
  }
  return resolvedPath;
}

// MCP Server Factory — creates a fresh server instance per connection
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
        return {
          content: [{ type: 'text', text: content }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Error reading note: ${err.message}` }],
          isError: true,
        };
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
        return {
          content: [{ type: 'text', text: `Successfully wrote note to ${notePath}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Error writing note: ${err.message}` }],
          isError: true,
        };
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
            const res = path.resolve(dir, entry.name);
            if (entry.name.startsWith('.')) continue;
            
            if (entry.isDirectory()) {
              await walkDir(res);
            } else if (entry.name.endsWith('.md')) {
              try {
                const content = await fs.readFile(res, 'utf-8');
                if (content.toLowerCase().includes(query.toLowerCase()) || entry.name.toLowerCase().includes(query.toLowerCase())) {
                  results.push(path.relative(VAULT_PATH, res));
                }
              } catch (e) {
                // ignore unreadable files
              }
            }
          }
        }
        
        await walkDir(VAULT_PATH);
        
        return {
          content: [{ type: 'text', text: results.length > 0 ? `Found ${results.length} notes matching "${query}":\n\n${results.join('\n')}` : `No notes found matching "${query}".` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Error searching notes: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ─── Auth helper ────────────────────────────────────────────────────────────
function extractToken(req: express.Request): string | undefined {
  const fromQuery = req.query.token as string | undefined;
  if (fromQuery) return fromQuery;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
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

// ─── Streamable HTTP transport (new protocol, used by Antigravity) ──────────
// Stateless: each POST creates a fresh server+transport, handles, and cleans up
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
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ─── Legacy SSE transport (old protocol, used by Claude Desktop) ────────────
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
    console.log(`SSE connection closed for session ${transport.sessionId}`);
    sseSessions.delete(transport.sessionId);
    try { await connectionServer.close(); } catch {}
  });
});

app.post('/mcp/messages', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    res.status(400).send('Missing sessionId');
    return;
  }

  const session = sseSessions.get(sessionId);
  if (!session) {
    res.status(404).send('Session not found');
    return;
  }

  await session.transport.handlePostMessage(req, res, req.body);
});

// ─── Health check ───────────────────────────────────────────────────────────
app.get('/mcp/health', (req, res) => {
  res.json({ status: 'ok', vaultPath: VAULT_PATH });
});

app.listen(PORT, async () => {
  console.log(`Obsidian Headless MCP Server running on port ${PORT}`);
  console.log(`Supports: Streamable HTTP (POST /mcp/sse) + Legacy SSE (GET /mcp/sse)`);
  await ensureVault();
});
