import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

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

// Auth middleware
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing or invalid Bearer token' });
    return;
  }
  
  const token = authHeader.split(' ')[1];
  if (token !== API_KEY) {
    res.status(403).json({ error: 'Forbidden: Invalid API Key' });
    return;
  }
  
  next();
});

// Setup MCP Server
const server = new McpServer({
  name: 'Obsidian Headless MCP',
  version: '1.0.0',
});

// Utility to safely resolve paths inside the vault
function resolveVaultPath(relativePath: string): string {
  // Bulletproof directory traversal prevention
  const resolvedPath = path.resolve(VAULT_PATH, relativePath);
  if (!resolvedPath.startsWith(path.resolve(VAULT_PATH))) {
    throw new Error('Security Error: Path traversal attempt detected.');
  }
  return resolvedPath;
}

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
      // Ensure directory exists
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
          // Skip .obsidian and hidden folders
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

// Global transport variable to keep track of SSE connection
let transport: SSEServerTransport;

// Endpoint for SSE connection
app.get('/mcp/sse', async (req, res) => {
  console.log('New SSE connection established');
  transport = new SSEServerTransport('/mcp/messages', res);
  await server.connect(transport);
});

// Endpoint for receiving messages
app.post('/mcp/messages', async (req, res) => {
  if (!transport) {
    res.status(400).send('No active SSE connection');
    return;
  }
  await transport.handlePostMessage(req, res);
});

// Basic health check
app.get('/mcp/health', (req, res) => {
  res.json({ status: 'ok', vaultPath: VAULT_PATH });
});

app.listen(PORT, async () => {
  console.log(`Obsidian Headless MCP Server running on port ${PORT}`);
  await ensureVault();
});
