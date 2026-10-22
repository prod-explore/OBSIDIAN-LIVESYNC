import matter from 'gray-matter';

export interface ParsedNote {
  frontmatter: Record<string, any>;
  body: string;
}

/**
 * Parses a markdown string into its YAML frontmatter and body components.
 */
export function parseNote(content: string): ParsedNote {
  // The (empty) options object is deliberate. Without options gray-matter caches the result per input text and
  // hands out the same `data` object every time, so a caller that fills in `google_id` on one note would
  // silently give that id to every other note (or later read) with identical text.
  const parsed = matter(content, {});
  return {
    frontmatter: parsed.data,
    body: parsed.content
  };
}

/**
 * Serializes frontmatter and body back into a markdown string with YAML blocks.
 */
export function serializeNote(frontmatter: Record<string, any>, body: string): string {
  // Ensure that empty body doesn't end up lacking a newline after the frontmatter closing block
  let normalizedBody = body;
  if (normalizedBody.length > 0 && !normalizedBody.startsWith('\n')) {
    normalizedBody = '\n' + normalizedBody;
  }
  
  return matter.stringify(normalizedBody, frontmatter);
}
