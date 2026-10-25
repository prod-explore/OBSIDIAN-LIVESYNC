/**
 * Mass-deletion guard.
 *
 * Push treats "a Google id we know about has no file in the vault any more" as "the user deleted
 * it" and deletes the record on Google. That is right for one note, and catastrophic when the
 * vault is merely unavailable: a volume that did not mount, a LiveSync fetch still in progress, a
 * renamed folder. Google Tasks has no undo for a deleted task, so a sudden disappearance of most
 * of a list is treated as a fault, not as a decision.
 */

/** Deleting this many records or fewer in one cycle is always allowed. */
export const MASS_DELETE_MIN = 5;

/** Above the minimum, more than this share of a list vanishing at once is refused. */
export const MASS_DELETE_SHARE = 0.5;

/** Would deleting `missing` of the `known` records of one list or calendar be a mass deletion? */
export function isMassDeletion(missing: number, known: number): boolean {
  if (missing <= MASS_DELETE_MIN || known === 0) return false;
  return missing / known > MASS_DELETE_SHARE;
}
