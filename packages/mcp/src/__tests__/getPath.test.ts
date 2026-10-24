// get_path through its real handler: the path guard as a client meets it, on reads.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { makeHarness, text, type Harness } from './harness.js';

let h: Harness;
let outside: string;

before(async () => {
  h = await makeHarness();
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-outside-'));
  await fs.writeFile(path.join(outside, 'secret.md'), 'OUTSIDE-SECRET');
  await h.write('Notes/ok.md', '# ok');
  await h.write('.obsidian/plugins/obsidian-livesync/data.json', '{"couchDB_PASSWORD":"HIDDEN-SECRET"}');
});

after(async () => {
  await h.cleanup();
  await fs.rm(outside, { recursive: true, force: true });
});

/** The call failed, and nothing it returned contains `secret`. */
function refused(res: Awaited<ReturnType<Harness['call']>>, secret: string, why: RegExp) {
  assert.equal(res.isError, true, text(res));
  assert.match(text(res), why);
  assert.ok(!text(res).includes(secret), text(res));
}

test('get_path refuses "..", an absolute path and a sibling folder with a shared prefix', async () => {
  const sibling = `${h.vault}-other`;
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'secret.md'), 'SIBLING-SECRET');
  try {
    refused(await h.call('get_path', { path: '../../etc/passwd' }), 'root:', /traversal/i);
    refused(await h.call('get_path', { path: path.join(outside, 'secret.md') }), 'OUTSIDE-SECRET', /traversal/i);
    refused(await h.call('get_path', { path: 'Notes/../../x' }), 'OUTSIDE-SECRET', /traversal/i);
    refused(
      await h.call('get_path', { path: `../${path.basename(sibling)}/secret.md` }),
      'SIBLING-SECRET',
      /traversal/i,
    );
  } finally {
    await fs.rm(sibling, { recursive: true, force: true });
  }
});

test('get_path does not read through a symbolic link that leads out of the vault', async () => {
  await fs.symlink(path.join(outside, 'secret.md'), path.join(h.vault, 'Notes', 'innocent.md'));
  await fs.symlink(outside, path.join(h.vault, 'linked-dir'));
  refused(await h.call('get_path', { path: 'Notes/innocent.md' }), 'OUTSIDE-SECRET', /traversal/i);
  refused(await h.call('get_path', { path: 'linked-dir/secret.md' }), 'OUTSIDE-SECRET', /traversal/i);
  refused(await h.call('get_path', { path: 'linked-dir' }), 'secret.md', /traversal/i);
});

test("get_path does not read the app's hidden settings, where LiveSync keeps its CouchDB password", async () => {
  refused(
    await h.call('get_path', { path: '.obsidian/plugins/obsidian-livesync/data.json' }),
    'HIDDEN-SECRET',
    /hidden/i,
  );
  refused(await h.call('get_path', { path: '.obsidian' }), 'plugins', /hidden/i);
  await fs.symlink(path.join(h.vault, '.obsidian'), path.join(h.vault, 'settings'));
  refused(
    await h.call('get_path', { path: 'settings/plugins/obsidian-livesync/data.json' }),
    'HIDDEN-SECRET',
    /hidden/i,
  );
});

test('get_path reads a note through a symbolic link that stays inside the vault', async () => {
  await fs.symlink(path.join(h.vault, 'Notes'), path.join(h.vault, 'alias'));
  const res = await h.call('get_path', { path: 'alias/ok.md' });
  assert.equal(res.isError, undefined);
  assert.equal(text(res), '# ok');
});

test('get_path lists the vault root without hidden entries', async () => {
  const res = await h.call('get_path');
  assert.equal(res.isError, undefined);
  assert.match(text(res), /📁 Notes {2}→ {2}Notes/);
  assert.ok(!text(res).includes('.obsidian'));
});
