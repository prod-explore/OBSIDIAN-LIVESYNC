// Calls the real tool handlers against a throw-away vault, with the arguments validated and defaulted by the
// tools' own zod schemas, as the MCP server does. No HTTP and no MCP client in between.
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import { registerAllTools } from '../tools/index.js';

export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface Harness {
  vault: string;
  config: Config;
  /** Calls a tool; `args` are parsed with the tool's schema, so defaults apply and bad input throws like it would on the wire. */
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  write(rel: string, content: string): Promise<void>;
  read(rel: string): Promise<string>;
  exists(rel: string): Promise<boolean>;
  /** Every file under `rel` (vault-relative, forward slashes), sorted. */
  files(rel?: string): Promise<string[]>;
  cleanup(): Promise<void>;
}

export async function makeHarness(over: Partial<Config> = {}): Promise<Harness> {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-tools-'));
  const config: Config = {
    port: 0,
    vaultPath: vault,
    vaultResolved: vault,
    apiKey: 'k',
    trashDir: '.trash',
    sseSessionMaxAgeMs: 60_000,
    sseSweepIntervalMs: 60_000,
    instructions: undefined,
    ...over,
  };

  const tools = new Map<string, { shape: z.ZodRawShape; handler: Handler }>();
  const server = {
    tool(name: string, _description: string, shape: z.ZodRawShape, handler: Handler) {
      tools.set(name, { shape, handler });
    },
  } as unknown as McpServer;
  registerAllTools(server, config);

  const full = (rel: string) => path.join(vault, rel);

  async function files(rel = ''): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string) {
      for (const entry of await fs.readdir(full(dir), { withFileTypes: true }).catch(() => [])) {
        const next = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(next);
        else out.push(next);
      }
    }
    await walk(rel);
    return out.sort();
  }

  return {
    vault,
    config,
    async call(tool, args = {}) {
      const registered = tools.get(tool);
      if (!registered) throw new Error(`no such tool: ${tool}`);
      return registered.handler(z.object(registered.shape).parse(args));
    },
    async write(rel, content) {
      await fs.mkdir(path.dirname(full(rel)), { recursive: true });
      await fs.writeFile(full(rel), content, 'utf-8');
    },
    read: (rel) => fs.readFile(full(rel), 'utf-8'),
    exists: (rel) =>
      fs.access(full(rel)).then(
        () => true,
        () => false,
      ),
    files,
    cleanup: () => fs.rm(vault, { recursive: true, force: true }),
  };
}

export const text = (result: ToolResult): string => result.content[0].text;
