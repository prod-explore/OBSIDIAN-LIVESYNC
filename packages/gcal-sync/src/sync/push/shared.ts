import * as fs from 'fs/promises';
import { serializeNote } from '../../markdown/frontmatter.js';
import type { NoteFields } from '../../markdown/notes.js';
import type { ScannedNote } from '../scan.js';

/** What a push leaves behind for the caller: the Google id the note now has, and the list or calendar it belongs to. */
export interface PushOutcome {
  googleId: string;
  containerId: string;
}

export function saveNote(fullPath: string, note: NoteFields, body: string): Promise<void> {
  return fs.writeFile(fullPath, serializeNote(note, body), 'utf-8');
}

/**
 * Creates the item on Google with a crash-safe marker around the call. `push_pending` is written to the note before
 * the insert and the real id replaces it after, so a crash in between is recognisable on the next cycle (see
 * `pushKind`). If the insert itself fails the marker is taken off again, so the next cycle simply tries again.
 */
export async function insertWithMarker<T>(
  entry: ScannedNote<NoteFields>,
  note: NoteFields,
  insert: () => Promise<T>,
): Promise<T> {
  note.push_pending = true;
  await saveNote(entry.fullPath, note, entry.body);
  try {
    return await insert();
  } catch (err) {
    delete note.push_pending;
    await saveNote(entry.fullPath, note, entry.body).catch(() => {}); // a second failure must not hide the first
    throw err;
  }
}

/** The title Google gets when the note has none: the file name without its extension and without the short id suffix. */
export function fallbackTitle(file: string, sanitize: (text: string) => string): string {
  return sanitize(file.replace(/\.md$/, '').replace(/-[a-z0-9]{8}$/i, ''));
}
