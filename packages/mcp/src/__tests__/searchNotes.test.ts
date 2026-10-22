import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import { registerSearchNotes, MAX_SEARCH_RESULTS } from '../tools/searchNotes.js';

type Result = { content: { type: string; text: string }[]; isError?: boolean };

async function search(vault: string, query: string): Promise<string> {
  let handler: ((args: { query: string }) => Promise<Result>) | undefined;
  registerSearchNotes({ tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => { handler = h; } } as unknown as McpServer, { config: { vaultResolved: vault } as unknown as Config });
  return (await handler!({ query })).content[0].text;
}

async function vaultWith(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-search-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content, 'utf-8');
  }
  return dir;
}

test('finds notes by content and by file name, case-insensitively', async () => {
  const dir = await vaultWith({ 'a.md': 'Project IDEAS here', 'Folder/ideas list.md': 'nothing', 'b.md': 'unrelated' });
  const out = await search(dir, 'ideas');
  assert.match(out, /Found 2 notes/);
  assert.match(out, /a\.md/);
  assert.match(out, /ideas list\.md/);
  assert.doesNotMatch(out, /b\.md/);
});

test('skips dot folders such as the trash', async () => {
  const dir = await vaultWith({ '.trash/gone.md': 'needle', 'kept.md': 'needle' });
  const out = await search(dir, 'needle');
  assert.match(out, /kept\.md/);
  assert.doesNotMatch(out, /gone\.md/);
});

test('does not read through symbolic links that lead out of the vault', async () => {
  const dir = await vaultWith({ 'inside.md': 'needle' });
  const outside = await vaultWith({ 'secret.md': 'needle outside' });
  await fs.symlink(path.join(outside, 'secret.md'), path.join(dir, 'link.md'));
  await fs.symlink(outside, path.join(dir, 'linked-dir'));
  const out = await search(dir, 'needle');
  assert.match(out, /Found 1 notes/);
  assert.doesNotMatch(out, /link|secret/);
});

test('stops at the result cap and says so', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < MAX_SEARCH_RESULTS + 20; i++) files[`n${i}.md`] = 'needle';
  const out = await search(await vaultWith(files), 'needle');
  assert.match(out, new RegExp(`Found ${MAX_SEARCH_RESULTS} notes`));
  assert.match(out, /Stopped at/);
});

test('reports a miss plainly', async () => {
  assert.match(await search(await vaultWith({ 'a.md': 'x' }), 'zzz'), /No notes found/);
});
