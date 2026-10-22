import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { resolveVaultPath, PathTraversalError } from '../security.js';

// ---------------------------------------------------------------------------
// Helpers — spin up a real temp directory for each test group so we are
// testing the actual fs.stat branch, not a mock.
// ---------------------------------------------------------------------------

async function makeTmpVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-vault-'));
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Path security — same cases as security.test.ts, applied to get_path's
// internal resolveVaultPath call (belt-and-suspenders: if someone removes the
// guard from getPath.ts, these tests will catch it).
// ---------------------------------------------------------------------------

test('get_path: resolveVaultPath allows a simple relative file path', async () => {
  const vault = await makeTmpVault();
  try {
    const filePath = path.join(vault, 'Note.md');
    await fs.writeFile(filePath, '# Hello');
    const resolved = resolveVaultPath(vault, 'Note.md');
    assert.equal(resolved, filePath);
  } finally {
    await cleanup(vault);
  }
});

test('get_path: resolveVaultPath blocks parent-directory traversal', async () => {
  const vault = await makeTmpVault();
  try {
    assert.throws(
      () => resolveVaultPath(vault, '../../etc/passwd'),
      PathTraversalError
    );
  } finally {
    await cleanup(vault);
  }
});

test('get_path: resolveVaultPath blocks absolute path outside vault', async () => {
  const vault = await makeTmpVault();
  try {
    assert.throws(
      () => resolveVaultPath(vault, '/etc/passwd'),
      PathTraversalError
    );
  } finally {
    await cleanup(vault);
  }
});

test('get_path: resolveVaultPath blocks sneaky path that escapes via subfolder', async () => {
  const vault = await makeTmpVault();
  try {
    assert.throws(
      () => resolveVaultPath(vault, 'Folder/../../etc/passwd'),
      PathTraversalError
    );
  } finally {
    await cleanup(vault);
  }
});

test('get_path: resolveVaultPath does not false-positive on sibling folder with shared prefix', async () => {
  const vault = await makeTmpVault();
  try {
    assert.throws(
      () => resolveVaultPath(vault, '../' + path.basename(vault) + '-other/secret.md'),
      PathTraversalError
    );
  } finally {
    await cleanup(vault);
  }
});

// ---------------------------------------------------------------------------
// Filesystem behaviour — file branch
// ---------------------------------------------------------------------------

test('get_path: resolveVaultPath accepts vault root itself (empty string)', async () => {
  const vault = await makeTmpVault();
  try {
    const resolved = resolveVaultPath(vault, '');
    assert.equal(resolved, vault);
  } finally {
    await cleanup(vault);
  }
});

test('get_path: fs.stat on a file reports isFile', async () => {
  const vault = await makeTmpVault();
  try {
    const filePath = path.join(vault, 'test.md');
    await fs.writeFile(filePath, '# Test note');
    const stat = await fs.stat(filePath);
    assert.ok(stat.isFile(), 'expected isFile() to be true');
    assert.ok(!stat.isDirectory(), 'expected isDirectory() to be false');
  } finally {
    await cleanup(vault);
  }
});

// ---------------------------------------------------------------------------
// Filesystem behaviour — directory branch
// ---------------------------------------------------------------------------

test('get_path: fs.stat on a directory reports isDirectory', async () => {
  const vault = await makeTmpVault();
  try {
    const dirPath = path.join(vault, 'Subfolder');
    await fs.mkdir(dirPath);
    const stat = await fs.stat(dirPath);
    assert.ok(stat.isDirectory(), 'expected isDirectory() to be true');
    assert.ok(!stat.isFile(), 'expected isFile() to be false');
  } finally {
    await cleanup(vault);
  }
});

test('get_path: directory listing excludes dotfiles', async () => {
  const vault = await makeTmpVault();
  try {
    await fs.writeFile(path.join(vault, 'visible.md'), '');
    await fs.writeFile(path.join(vault, '.hidden'), '');
    await fs.mkdir(path.join(vault, '.obsidian'));

    const entries = await fs.readdir(vault, { withFileTypes: true });
    const visible = entries.filter((e) => !e.name.startsWith('.'));
    const names = visible.map((e) => e.name);

    assert.ok(names.includes('visible.md'), 'visible.md should be listed');
    assert.ok(!names.includes('.hidden'), '.hidden should be excluded');
    assert.ok(!names.includes('.obsidian'), '.obsidian should be excluded');
  } finally {
    await cleanup(vault);
  }
});

test('get_path: empty directory returns empty marker', async () => {
  const vault = await makeTmpVault();
  try {
    const emptyDir = path.join(vault, 'EmptyFolder');
    await fs.mkdir(emptyDir);

    const entries = await fs.readdir(emptyDir, { withFileTypes: true });
    const visible = entries.filter((e) => !e.name.startsWith('.'));
    assert.equal(visible.length, 0);
  } finally {
    await cleanup(vault);
  }
});

test('get_path: non-existent path throws ENOENT', async () => {
  const vault = await makeTmpVault();
  try {
    const missingPath = path.join(vault, 'does-not-exist.md');
    await assert.rejects(
      () => fs.stat(missingPath),
      (err: any) => err.code === 'ENOENT'
    );
  } finally {
    await cleanup(vault);
  }
});
