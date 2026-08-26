import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNote, serializeNote } from '../markdown/frontmatter.js';

test('parseNote extracts frontmatter and body', () => {
  const note = `---\ntitle: Hello\nstatus: confirmed\n---\n# Body\nHere is text.`;
  const result = parseNote(note);
  
  assert.equal(result.frontmatter.title, 'Hello');
  assert.equal(result.frontmatter.status, 'confirmed');
  assert.equal(result.body.trim(), '# Body\nHere is text.');
});

test('serializeNote reconstructs note accurately', () => {
  const frontmatter = { type: 'event', status: 'cancelled' };
  const body = '\n# Notes\nSome body text';
  
  const serialized = serializeNote(frontmatter, body);
  assert.ok(serialized.startsWith('---'));
  assert.ok(serialized.includes('type: event'));
  assert.ok(serialized.includes('status: cancelled'));
  assert.ok(serialized.includes('---'));
  assert.ok(serialized.includes('# Notes'));
});
