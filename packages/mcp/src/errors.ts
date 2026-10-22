/** What a failed call tells us, without trusting its shape. */

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `code` of a system error such as "ENOENT", if it has one. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** The file or folder is not there. */
export const isFileMissing = (err: unknown): boolean => errorCode(err) === 'ENOENT';
