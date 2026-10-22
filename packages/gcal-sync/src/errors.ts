/**
 * What a failed call tells us, without trusting its shape. Google's client throws errors that carry a numeric
 * `code` and `status`; the file system throws errors with a string `code` such as "ENOENT".
 */

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasCode(err: unknown, wanted: string | number): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, status } = err as { code?: unknown; status?: unknown };
  return code === wanted || status === wanted;
}

/** The file or folder is not there (it may have been moved or deleted between listing and reading). */
export const isFileMissing = (err: unknown): boolean => hasCode(err, 'ENOENT');

/** Google no longer honours a sync token (HTTP 410). */
export const isGone = (err: unknown): boolean => hasCode(err, 410);

/** The record is already gone from Google (404 or 410), which is what a delete wanted anyway. */
export const isAlreadyGone = (err: unknown): boolean => hasCode(err, 404) || hasCode(err, 410);
