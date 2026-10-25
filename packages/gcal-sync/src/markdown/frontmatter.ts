import matter from 'gray-matter';
import type { RawFrontmatter } from './notes.js';

export interface ParsedNote {
  frontmatter: RawFrontmatter;
  body: string;
}

/**
 * Parses a markdown string into its YAML frontmatter and body components. Throws when the YAML is not valid.
 * What comes back is as the parser typed it; `readTaskNote` / `readEventNote` make it a typed note.
 */
export function parseNote(content: string): ParsedNote {
  // The (empty) options object is deliberate. Without options gray-matter caches the result per input text and
  // hands out the same `data` object every time, so a caller that fills in `google_id` on one note would
  // silently give that id to every other note (or later read) with identical text.
  const parsed = matter(content, {});
  return {
    frontmatter: parsed.data,
    body: parsed.content,
  };
}

/**
 * Serializes front matter and body back into a Markdown note.
 */
export function serializeNote(frontmatter: RawFrontmatter, body: string): string {
  // A blank line between the closing `---` and the body. A body read by parseNote already starts with that
  // newline, so a read and a write do not add another one each time.
  let normalizedBody = body;
  if (normalizedBody.length > 0 && !normalizedBody.startsWith('\n')) {
    normalizedBody = '\n' + normalizedBody;
  }

  return matter.stringify(normalizedBody, frontmatter);
}
