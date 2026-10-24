import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

test('the server refuses to start without an API key', () => {
  assert.throws(() => loadConfig({ VAULT_PATH: '/vault' }), /MCP_API_KEY/);
  assert.throws(() => loadConfig({ MCP_API_KEY: '' }), /MCP_API_KEY/);
});

test('defaults: port 3000, vault /vault, trash in .trash', () => {
  const config = loadConfig({ MCP_API_KEY: 'k' });
  assert.equal(config.port, 3000);
  assert.equal(config.vaultResolved, '/vault');
  assert.equal(config.trashDir, '.trash');
});

test('port, vault and trash folder come from the environment', () => {
  const config = loadConfig({ MCP_API_KEY: 'k', PORT: '4100', VAULT_PATH: '/data/vault', TRASH_DIR: '_deleted' });
  assert.deepEqual([config.port, config.vaultResolved, config.trashDir], [4100, '/data/vault', '_deleted']);
});

test('the body limit is 5 MB unless the environment says otherwise', () => {
  assert.equal(loadConfig({ MCP_API_KEY: 'k' }).bodyLimit, '5mb');
  assert.equal(loadConfig({ MCP_API_KEY: 'k', MCP_BODY_LIMIT: '20mb' }).bodyLimit, '20mb');
  assert.equal(loadConfig({ MCP_API_KEY: 'k', MCP_BODY_LIMIT: '  ' }).bodyLimit, '5mb');
});

test('writes are limited to 120 a minute unless the environment says otherwise; 0 turns the limit off', () => {
  assert.deepEqual(loadConfig({ MCP_API_KEY: 'k' }).writeLimit, { max: 120, windowMs: 60_000 });
  assert.equal(loadConfig({ MCP_API_KEY: 'k', MCP_WRITE_LIMIT_PER_MINUTE: '10' }).writeLimit.max, 10);
  assert.equal(loadConfig({ MCP_API_KEY: 'k', MCP_WRITE_LIMIT_PER_MINUTE: '0' }).writeLimit.max, 0);
  assert.equal(loadConfig({ MCP_API_KEY: 'k', MCP_WRITE_LIMIT_PER_MINUTE: 'lots' }).writeLimit.max, 120);
  assert.equal(loadConfig({ MCP_API_KEY: 'k', MCP_WRITE_LIMIT_PER_MINUTE: '-5' }).writeLimit.max, 120);
});
