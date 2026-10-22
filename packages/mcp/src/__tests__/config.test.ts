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
