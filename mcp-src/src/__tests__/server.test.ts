import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server.js';
import { resolveInstructions, DEFAULT_INSTRUCTIONS, type Config } from '../config.js';

const KEY = 'test-key-with-some-length-1234567890';
let http: Server;
let base: string;
let vault: string;
let closeApp: () => void;

before(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-server-'));
  const config: Config = {
    port: 0,
    vaultPath: vault,
    vaultResolved: vault,
    apiKey: KEY,
    trashDir: '.trash',
    sseSessionMaxAgeMs: 60_000,
    sseSweepIntervalMs: 60_000,
    instructions: undefined,
  };
  const { app, sseRegistry } = createApp(config);
  closeApp = () => sseRegistry.stopSweeping();
  http = app.listen(0);
  await new Promise((r) => http.once('listening', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

after(async () => {
  closeApp();
  await new Promise((r) => http.close(r));
  await fs.rm(vault, { recursive: true, force: true });
});

test('health requires a token', async () => {
  assert.equal((await fetch(`${base}/mcp/health`)).status, 401);
});

test('health rejects a wrong token, in the header and in the query string', async () => {
  assert.equal((await fetch(`${base}/mcp/health`, { headers: { authorization: 'Bearer nope' } })).status, 403);
  assert.equal((await fetch(`${base}/mcp/health?token=nope`)).status, 403);
});

test('health accepts the token as a Bearer header or as ?token=', async () => {
  for (const res of [
    await fetch(`${base}/mcp/health`, { headers: { authorization: `Bearer ${KEY}` } }),
    await fetch(`${base}/mcp/health?token=${KEY}`),
  ]) {
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string; vaultExists: boolean };
    assert.equal(body.status, 'ok');
    assert.equal(body.vaultExists, true);
  }
});

test('OAuth discovery answers with a plain 404, not a 401', async () => {
  assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404);
  assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource`)).status, 404);
});

test('streamable HTTP and the legacy SSE entry point both refuse an unauthenticated client', async () => {
  const post = await fetch(`${base}/mcp/sse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 401);
  assert.equal((await fetch(`${base}/mcp/sse`)).status, 401);
});

test('posting a message for an unknown SSE session is a 404, a missing id a 400', async () => {
  assert.equal((await fetch(`${base}/mcp/messages?sessionId=nope`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 404);
  assert.equal((await fetch(`${base}/mcp/messages`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 400);
});

test('an authenticated MCP client can list the tools the README documents', async () => {
  const res = await fetch(`${base}/mcp/sse`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const payload = text.split('\n').find((l) => l.startsWith('data:'));
  const message = JSON.parse(payload ? payload.slice(5) : text) as { result: { tools: { name: string }[] } };
  assert.deepEqual(
    message.result.tools.map((t) => t.name).sort(),
    ['delete_note', 'edit_note', 'get_path', 'get_vault_tree', 'move_note', 'search_notes', 'write_note']
  );
});

test('clients are pointed at the vault\'s own rules file by default; MCP_INSTRUCTIONS replaces that, "none" removes it', () => {
  assert.equal(resolveInstructions({}), DEFAULT_INSTRUCTIONS);
  assert.equal(resolveInstructions({ MCP_INSTRUCTIONS: '' }), DEFAULT_INSTRUCTIONS, 'empty = unset, so compose can pass it through');
  assert.ok(DEFAULT_INSTRUCTIONS.includes('_Systems/AGENTS.md'));
  assert.equal(resolveInstructions({ MCP_INSTRUCTIONS: ' Read the rules in Meta/Rules.md first. ' }), 'Read the rules in Meta/Rules.md first.');
  assert.equal(resolveInstructions({ MCP_INSTRUCTIONS: 'none' }), undefined);
});
