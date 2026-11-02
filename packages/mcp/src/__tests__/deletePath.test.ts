// delete_path through its real handler against a real (temporary) vault: a note goes to the trash, an empty folder is
// removed, and everything else is refused and left exactly as it was.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { makeHarness, text, type Harness, type ToolResult } from './harness.js';
import { withBeforeRmdir } from './fsFaults.js';

let h: Harness;
before(async () => {
  h = await makeHarness();
});
after(() => h.cleanup());

const mkdir = (rel: string) => fs.mkdir(path.join(h.vault, rel), { recursive: true });
const isFolder = (rel: string) =>
  fs.stat(path.join(h.vault, rel)).then(
    (s) => s.isDirectory(),
    () => false,
  );

function refused(res: ToolResult, why: RegExp) {
  assert.equal(res.isError, true, text(res));
  assert.match(text(res), why);
}

test('an empty folder is deleted', async () => {
  await mkdir('Empty/Inner');
  const res = await h.call('delete_path', { path: 'Empty/Inner' });
  assert.equal(res.isError, undefined, text(res));
  assert.equal(text(res), 'Deleted empty folder: Empty/Inner');
  assert.equal(await h.exists('Empty/Inner'), false);
  assert.equal(await isFolder('Empty'), true, 'only the folder named, not the one above it');
});

test('a folder with anything in it is refused, says how much, and is left as it was', async () => {
  await h.write('Full/a.md', 'a');
  await h.write('Full/b.md', 'b');
  await mkdir('Full/Sub');
  const res = await h.call('delete_path', { path: 'Full' });
  refused(res, /^Folder Full is not empty \(3 items\): delete or move its notes and subfolders first$/);
  assert.deepEqual(await h.files('Full'), ['Full/a.md', 'Full/b.md']);
  assert.equal(await isFolder('Full/Sub'), true);
  assert.deepEqual(await h.files('.trash'), [], 'nothing was trashed on the way');
});

test('a folder that holds only an empty folder is not empty either: nothing is removed recursively', async () => {
  await mkdir('Nested/Empty');
  refused(await h.call('delete_path', { path: 'Nested' }), /not empty \(1 item\)/);
  assert.equal(await isFolder('Nested/Empty'), true);
});

test('a folder that holds only hidden files is not empty, and the refusal says they are hidden', async () => {
  await h.write('Mac/.DS_Store', 'x');
  const res = await h.call('delete_path', { path: 'Mac' });
  refused(res, /not empty: it holds only 1 hidden item \(\.DS_Store\), which this server cannot reach/);
  assert.equal(await h.exists('Mac/.DS_Store'), true);
});

test('hidden items among notes are counted and named, at most five of them', async () => {
  await h.write('Mixed/Note.md', 'n');
  for (const name of ['.a', '.b', '.c', '.d', '.e', '.f']) await h.write(`Mixed/${name}`, 'x');
  const res = await h.call('delete_path', { path: 'Mixed' });
  refused(res, /not empty \(7 items, 6 of them hidden: \.a, \.b, \.c, \.d, \.e and 1 more\): delete or move/);
  assert.equal(await h.exists('Mixed/Note.md'), true);
});

test('a note written into the folder after every check, right before rmdir, makes it fail; the note stays', async () => {
  await mkdir('Racy');
  const res = await withBeforeRmdir(
    (folder) => fs.writeFile(path.join(folder, 'Arrived.md'), 'just in time'),
    () => h.call('delete_path', { path: 'Racy' }),
  );
  refused(res, /^Folder Racy is not empty \(1 item\)/);
  assert.equal(await h.read('Racy/Arrived.md'), 'just in time');
});

const notEmptyError = () =>
  Object.assign(new Error('ENOTEMPTY: directory not empty (simulated)'), { code: 'ENOTEMPTY' });

test('a folder emptied again between the failed rmdir and the listing gets a message that says so', async () => {
  await mkdir('Flicker');
  const res = await withBeforeRmdir(
    () => Promise.reject(notEmptyError()),
    () => h.call('delete_path', { path: 'Flicker' }),
  );
  refused(res, /^Folder Flicker is not empty: its contents changed while it was being deleted; check it with get_path/);
  assert.equal(await isFolder('Flicker'), true);
});

test('a folder refused as not empty that cannot be listed afterwards is still refused, without a count', async () => {
  await mkdir('Gone');
  const res = await withBeforeRmdir(
    async (folder) => {
      await fs.rm(folder, { recursive: true }); // not rmdir: that is the replaced function
      throw notEmptyError();
    },
    () => h.call('delete_path', { path: 'Gone' }),
  );
  refused(res, /^Folder Gone is not empty: delete or move its notes and subfolders first$/);
});

test('a folder that is gone by the time rmdir runs is reported as missing', async () => {
  await mkdir('Vanishing');
  const res = await withBeforeRmdir(
    (folder) => fs.rm(folder, { recursive: true }),
    () => h.call('delete_path', { path: 'Vanishing' }),
  );
  refused(res, /^Nothing to delete: Vanishing does not exist$/);
});

test('an unexpected rmdir failure reaches the client as an error, with the folder left alone', async () => {
  await mkdir('Busy');
  const res = await withBeforeRmdir(
    () => Promise.reject(Object.assign(new Error('EBUSY: resource busy (simulated)'), { code: 'EBUSY' })),
    () => h.call('delete_path', { path: 'Busy' }),
  );
  refused(res, /^Error deleting path: EBUSY/);
  assert.equal(await isFolder('Busy'), true);
});

test('the vault root is refused, however it is spelled', async () => {
  for (const root of ['', '.', './', 'Notes/..']) {
    refused(await h.call('delete_path', { path: root }), /the vault root cannot be deleted/);
  }
  assert.equal(await isFolder(''), true);
});

test('the layout the Google sync is built on is refused, even empty and in another case', async () => {
  const layout = ['{Tasks}', '{Calendar}', '04-Archive/{Tasks}', '04-Archive/{Calendar}', '04-Archive', '_Systems'];
  for (const rel of [...layout, '{tasks}']) await mkdir(rel);
  for (const rel of [...layout, '{tasks}']) {
    refused(await h.call('delete_path', { path: rel }), /part of the layout the Google sync relies on/);
    assert.equal(await isFolder(rel), true, rel);
  }
});

test('a task list folder and its archive mirror are refused even empty: deleting one deletes the list in Google', async () => {
  for (const rel of ['{Tasks}/Groceries', '04-Archive/{Tasks}/Groceries']) {
    await mkdir(rel);
    const res = await h.call('delete_path', { path: rel });
    refused(res, /folder of a Google Tasks list.*would delete the list in Google.*delete it in Google Tasks/);
    assert.equal(await isFolder(rel), true, rel);
  }
});

test('a calendar month folder is refused even empty; folders deeper in the synced roots are ordinary', async () => {
  for (const rel of ['{Calendar}/2026-11', '04-Archive/{Calendar}/2025-01']) {
    await mkdir(rel);
    refused(await h.call('delete_path', { path: rel }), /month folder of the Google sync/);
    assert.equal(await isFolder(rel), true, rel);
  }
  for (const rel of ['{Tasks}/Groceries/Someday', '{Calendar}/Trips', '_Systems/duplicates']) {
    await mkdir(rel);
    const res = await h.call('delete_path', { path: rel });
    assert.equal(res.isError, undefined, `${rel}: ${text(res)}`);
    assert.equal(await h.exists(rel), false, rel);
  }
});

test('a hidden folder, the trash, and a path out of the vault are refused before anything is looked at', async () => {
  await mkdir('.obsidian/plugins');
  await mkdir('.trash');
  refused(await h.call('delete_path', { path: '.obsidian/plugins' }), /hidden/);
  refused(await h.call('delete_path', { path: '.trash' }), /hidden/);
  refused(await h.call('delete_path', { path: 'Notes/../../outside' }), /traversal/i);
  refused(await h.call('delete_path', { path: path.join(os.tmpdir(), 'x') }), /traversal/i);
  assert.equal(await isFolder('.obsidian/plugins'), true);
  assert.equal(await isFolder('.trash'), true);
});

test('links: one out of the vault is refused, one to a folder is not followed, one to the sync layout is no way round', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-outside-'));
  try {
    await fs.mkdir(path.join(outside, 'empty'));
    await mkdir('Target');
    await mkdir('{Tasks}/Work');
    await fs.symlink(outside, path.join(h.vault, 'out-link'));
    await fs.symlink(path.join(h.vault, 'Target'), path.join(h.vault, 'folder-link'));
    await fs.symlink(path.join(h.vault, '{Tasks}'), path.join(h.vault, 'tasks-link'));
    await fs.symlink(path.join(h.vault, '.obsidian'), path.join(h.vault, 'hidden-link'));

    refused(await h.call('delete_path', { path: 'out-link/empty' }), /traversal/i);
    refused(await h.call('delete_path', { path: 'out-link' }), /traversal/i);
    refused(await h.call('delete_path', { path: 'hidden-link/plugins' }), /hidden/);
    refused(await h.call('delete_path', { path: 'folder-link' }), /is a link to a folder/);
    refused(await h.call('delete_path', { path: 'tasks-link/Work' }), /folder of a Google Tasks list/);
    refused(await h.call('delete_path', { path: 'tasks-link' }), /is a link to a folder/);

    assert.deepEqual(await fs.readdir(outside), ['empty']);
    assert.equal(await isFolder('Target'), true);
    assert.equal(await isFolder('{Tasks}/Work'), true);
    assert.equal(await isFolder('.obsidian/plugins'), true);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('a note still goes to the trash, never unlinked', async () => {
  await h.write('Inbox/Idea.md', 'the idea');
  const res = await h.call('delete_path', { path: 'Inbox/Idea.md' });
  assert.equal(res.isError, undefined, text(res));
  assert.match(text(res), /^Moved to trash: Inbox\/Idea\.md → \.trash\/[^/]+__Inbox__Idea\.md$/);
  assert.equal(await h.exists('Inbox/Idea.md'), false);
  const saved = (await h.files('.trash')).find((f) => f.endsWith('__Inbox__Idea.md'));
  assert.ok(saved);
  assert.equal(await h.read(saved), 'the idea');
  assert.equal(await isFolder('Inbox'), true, 'the folder of a deleted note stays');
});

test('anything that is neither a note nor a folder is refused', async (t) => {
  const fifo = path.join(h.vault, 'pipe');
  try {
    execFileSync('mkfifo', [fifo]);
  } catch {
    t.skip('mkfifo is not available');
    return;
  }
  refused(await h.call('delete_path', { path: 'pipe' }), /Not a note or a folder: pipe/);
});

test('deleting a folder counts against the write limit like any other change', async () => {
  const limited = await makeHarness({ writeLimit: { max: 1, windowMs: 60_000 } });
  try {
    await fs.mkdir(path.join(limited.vault, 'One'));
    await fs.mkdir(path.join(limited.vault, 'Two'));
    assert.equal((await limited.call('delete_path', { path: 'One' })).isError, undefined);
    refused(await limited.call('delete_path', { path: 'Two' }), /Too many changes.*Try again in \d+s/);
    assert.equal(await limited.exists('Two'), true);
  } finally {
    await limited.cleanup();
  }
});
