import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { updateBacklinks } from '../tools/refactorLinks.js';

async function makeVault(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-links-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
  }
  return dir;
}

const read = (dir: string, rel: string) => fs.readFile(path.join(dir, rel), 'utf-8');

/** The caller (move_note) has already renamed the file when it asks for the links to be fixed. */
async function move(dir: string, from: string, to: string) {
  await fs.mkdir(path.dirname(path.join(dir, to)), { recursive: true });
  await fs.rename(path.join(dir, from), path.join(dir, to));
  return updateBacklinks(dir, from, to);
}

test('renaming a note rewrites wikilinks and keeps heading and alias', async () => {
  const dir = await makeVault({
    'Inbox/draft.md': '# draft',
    'Daily.md': 'See [[draft]], [[draft#Plan]], [[draft|the draft]] and [[draft#Plan|plan]].',
  });
  const changed = await move(dir, 'Inbox/draft.md', 'Inbox/final.md');
  assert.equal(changed, 1);
  assert.equal(
    await read(dir, 'Daily.md'),
    'See [[final]], [[final#Plan]], [[final|the draft]] and [[final#Plan|plan]].',
  );
});

test('markdown links are rewritten too', async () => {
  const dir = await makeVault({
    'a.md': '# a',
    'b.md': 'Open [it](a.md) or [encoded](My%20Note.md).',
  });
  await move(dir, 'a.md', 'z.md');
  assert.equal(await read(dir, 'b.md'), 'Open [it](z.md) or [encoded](My%20Note.md).');
});

test('a link that spells out the folder keeps its folder', async () => {
  const dir = await makeVault({
    'Projects/Plan.md': '# plan',
    'Index.md': 'Go to [[Projects/Plan]] or [text](Projects/Plan.md).',
  });
  await move(dir, 'Projects/Plan.md', 'Archive/Plan.md');
  assert.equal(await read(dir, 'Index.md'), 'Go to [[Archive/Plan]] or [text](Archive/Plan.md).');
});

test('moving a note to another folder under the same name touches nothing', async () => {
  const original = 'Links: [[draft]] and [[draft|alias]].';
  const dir = await makeVault({ 'Inbox/draft.md': '# draft', 'Daily.md': original });
  const before = (await fs.stat(path.join(dir, 'Daily.md'))).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(await move(dir, 'Inbox/draft.md', 'Areas/draft.md'), 0);
  assert.equal(await read(dir, 'Daily.md'), original);
  assert.equal(
    (await fs.stat(path.join(dir, 'Daily.md'))).mtimeMs,
    before,
    'file was rewritten although nothing changed',
  );
});

test('bare-name links are left alone when another note shares the name', async () => {
  const dir = await makeVault({
    'A/Index.md': '# a index',
    'B/Index.md': '# b index',
    'Hub.md': 'Bare [[Index]], bare md [x](Index.md), qualified [[A/Index]] and [[B/Index]].',
  });
  await move(dir, 'A/Index.md', 'A/Home.md');
  assert.equal(
    await read(dir, 'Hub.md'),
    'Bare [[Index]], bare md [x](Index.md), qualified [[A/Home]] and [[B/Index]].',
  );
});

test('a root-level note whose name is shared is not rewritten at all', async () => {
  const dir = await makeVault({ 'Index.md': '# root', 'Sub/Index.md': '# sub', 'Hub.md': '[[Index]]' });
  assert.equal(await move(dir, 'Index.md', 'Home.md'), 0);
  assert.equal(await read(dir, 'Hub.md'), '[[Index]]');
});

test('link matching ignores case and escapes regex characters in names', async () => {
  const dir = await makeVault({ 'What (is) this?.md': '#', 'x.md': 'See [[what (IS) this?]].' });
  assert.equal(await move(dir, 'What (is) this?.md', 'Renamed.md'), 1);
  assert.equal(await read(dir, 'x.md'), 'See [[Renamed]].');
});

test('dot folders (.trash, .obsidian) are never rewritten', async () => {
  const dir = await makeVault({
    'n.md': '#',
    '.trash/old.md': 'Was [[n]]',
    '.obsidian/notes.md': '[[n]]',
    'live.md': '[[n]]',
  });
  await move(dir, 'n.md', 'm.md');
  assert.equal(await read(dir, '.trash/old.md'), 'Was [[n]]');
  assert.equal(await read(dir, '.obsidian/notes.md'), '[[n]]');
  assert.equal(await read(dir, 'live.md'), '[[m]]');
});
