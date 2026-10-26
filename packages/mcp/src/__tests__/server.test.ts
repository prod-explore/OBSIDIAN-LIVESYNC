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
let baseConfig: Config;

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
    bodyLimit: '5mb',
    writeLimit: { max: 0, windowMs: 60_000 },
    instructions: undefined,
  };
  baseConfig = config;
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
    const body = (await res.json()) as { status: string; vaultExists: boolean };
    assert.equal(body.status, 'ok');
    assert.equal(body.vaultExists, true);
  }
});

test('OAuth discovery answers with a plain 404, not a 401', async () => {
  assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404);
  assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource`)).status, 404);
});

test('streamable HTTP and the legacy SSE entry point both refuse an unauthenticated client', async () => {
  const post = await fetch(`${base}/mcp/sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(post.status, 401);
  assert.equal((await fetch(`${base}/mcp/sse`)).status, 401);
});

test('posting a message needs the token: without one it is a 401, with a wrong one a 403', async () => {
  const noToken = await fetch(`${base}/mcp/messages?sessionId=nope`, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(noToken.status, 401);
  const wrongToken = await fetch(`${base}/mcp/messages?sessionId=nope`, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-key' },
  });
  assert.equal(wrongToken.status, 403);
});

test('posting a message for an unknown SSE session is a 404, a missing id a 400', async () => {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` };
  assert.equal(
    (await fetch(`${base}/mcp/messages?sessionId=nope`, { method: 'POST', body: '{}', headers })).status,
    404,
  );
  assert.equal((await fetch(`${base}/mcp/messages`, { method: 'POST', body: '{}', headers })).status, 400);
});

/** Opens a legacy SSE stream and returns the endpoint the server announces plus a way to close it. */
async function openSse(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ endpoint: string; close: () => void }> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  let seen = '';
  while (!/event: endpoint\ndata: (.+)\n/.test(seen)) {
    const { value, done } = await reader.read();
    assert.ok(!done, 'stream ended before the endpoint event');
    seen += new TextDecoder().decode(value);
  }
  const endpoint = /event: endpoint\ndata: (.+)\n/.exec(seen)![1];
  return { endpoint, close: () => controller.abort() };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
});

test('a legacy SSE session opened with a header posts with the header, and the session id alone is refused', async () => {
  const { endpoint, close } = await openSse(`${base}/mcp/sse`, { authorization: `Bearer ${KEY}` });
  try {
    assert.ok(!endpoint.includes('token='), 'a header client is not handed the token back');
    const post = (headers: Record<string, string>) =>
      fetch(`${base}${endpoint}`, {
        method: 'POST',
        body: INITIALIZE,
        headers: { 'content-type': 'application/json', ...headers },
      });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: `Bearer ${KEY}` })).status, 202);
  } finally {
    close();
  }
});

test('a legacy SSE session opened with ?token= is told an endpoint that carries the token', async () => {
  const { endpoint, close } = await openSse(`${base}/mcp/sse?token=${encodeURIComponent(KEY)}`);
  try {
    assert.ok(endpoint.includes('sessionId='));
    const res = await fetch(`${base}${endpoint}`, {
      method: 'POST',
      body: INITIALIZE,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 202);
  } finally {
    close();
  }
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
  assert.deepEqual(message.result.tools.map((t) => t.name).sort(), [
    'delete_note',
    'edit_note',
    'get_path',
    'get_vault_tree',
    'move_note',
    'search_notes',
    'write_note',
  ]);
});

test('clients are pointed at the vault\'s own rules file by default; MCP_INSTRUCTIONS replaces that, "none" removes it', () => {
  assert.equal(resolveInstructions({}), DEFAULT_INSTRUCTIONS);
  assert.equal(
    resolveInstructions({ MCP_INSTRUCTIONS: '' }),
    DEFAULT_INSTRUCTIONS,
    'empty = unset, so compose can pass it through',
  );
  assert.ok(DEFAULT_INSTRUCTIONS.includes('_Systems/AGENTS.md'));
  assert.equal(
    resolveInstructions({ MCP_INSTRUCTIONS: ' Read the rules in Meta/Rules.md first. ' }),
    'Read the rules in Meta/Rules.md first.',
  );
  assert.equal(resolveInstructions({ MCP_INSTRUCTIONS: 'none' }), undefined);
});

test('a rejected request is logged with its path, and the token it carried (query or header) never is', async () => {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => (
    written.push(String(chunk)),
    true
  )) as typeof process.stderr.write;
  try {
    await fetch(`${base}/mcp/health?token=guess-1234`);
    await fetch(`${base}/mcp/health`, { headers: { authorization: 'Bearer guess-5678' } });
    await fetch(`${base}/mcp/health`);
  } finally {
    process.stderr.write = original;
  }
  const log = written.join('');
  assert.match(log, /Rejected a request: wrong token/);
  assert.match(log, /Rejected a request: no token/);
  assert.match(log, /\/mcp\/health/);
  assert.ok(!log.includes('guess-1234'), 'the guessed token must not be in the log');
  assert.ok(!log.includes('guess-5678'), 'nor the one sent as a Bearer header');
});

test('a malformed body is a JSON 400, logged without the body and without a stack trace', async () => {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => (
    written.push(String(chunk)),
    true
  )) as typeof process.stderr.write;
  let res: Response;
  try {
    res = await fetch(`${base}/mcp/sse?token=${KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc": "2.0", "params": {"content": "BODY-TEXT-1234"',
    });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Bad request body' });
  const log = written.join('');
  assert.match(log, /Rejected a request body/);
  assert.match(log, /entity\.parse\.failed/);
  assert.ok(!log.includes('BODY-TEXT-1234'), log);
  assert.ok(!log.includes(KEY), log);
  assert.ok(!/\n\s+at /.test(log), 'no stack trace');
});

test('a base64 key with + works in ?token= unencoded, encoded and as a header; a wrong one still does not', async () => {
  const key = 'q+Wd7/ab+Zx9Lk0Nn3Rr2Ss1Tt5Uu8Vv6Ww4Xx0Yy=';
  const keyed = createApp({ ...baseConfig, apiKey: key });
  const srv = keyed.app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const health = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp/health`;
    const status = async (url: string, init?: RequestInit) => (await fetch(url, init)).status;
    // Pasted as it is: the query string turns each + into a space.
    assert.equal(await status(`${health}?token=${key}`), 200);
    assert.equal(await status(`${health}?token=${encodeURIComponent(key)}`), 200);
    assert.equal(await status(health, { headers: { authorization: `Bearer ${key}` } }), 200);
    // The space is only read back as + in the query string, and only a whole match counts.
    assert.equal(await status(health, { headers: { authorization: `Bearer ${key.replaceAll('+', ' ')}` } }), 403);
    assert.equal(await status(`${health}?token=${key.replace('q+', 'q-')}`), 403);
  } finally {
    keyed.sseRegistry.stopSweeping();
    await new Promise((r) => srv.close(r));
  }
});

test('a key that really holds a space still works in ?token=', async () => {
  const keyed = createApp({ ...baseConfig, apiKey: 'two words' });
  const srv = keyed.app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const health = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp/health`;
    assert.equal((await fetch(`${health}?token=two%20words`)).status, 200);
    assert.equal((await fetch(`${health}?token=two+words`)).status, 200);
  } finally {
    keyed.sseRegistry.stopSweeping();
    await new Promise((r) => srv.close(r));
  }
});

test('a body over the limit is a JSON 413, a note of a few hundred kB is not', async () => {
  const small = createApp({ ...baseConfig, bodyLimit: '1kb' });
  const srv = small.app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp/sse?token=${KEY}`;
    const post = (body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const res = await post({ jsonrpc: '2.0', method: 'x', params: { text: 'a'.repeat(5_000) } });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'Bad request body' });
  } finally {
    small.sseRegistry.stopSweeping();
    await new Promise((r) => srv.close(r));
  }

  // With the default limit, a 300 kB body gets as far as the MCP layer (which rejects it as a malformed request).
  const res = await fetch(`${base}/mcp/sse?token=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { text: 'a'.repeat(300_000) } }),
  });
  assert.notEqual(res.status, 413);
});

test('the server introduces itself with the version in package.json', async () => {
  const { version } = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf-8')) as {
    version: string;
  };
  const res = await fetch(`${base}/mcp/sse`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }),
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  const payload = raw.split('\n').find((l) => l.startsWith('data:'));
  const message = JSON.parse(payload ? payload.slice(5) : raw) as { result: { serverInfo: { version: string } } };
  assert.equal(message.result.serverInfo.version, version);
});
