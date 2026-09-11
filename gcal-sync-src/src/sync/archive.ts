/**
 * Folder prefix that marks a note as archived. Shared by ingest.ts and
 * push.ts so both directions agree on the same string — previously each
 * file declared its own local copy of this literal.
 */
export const ARCHIVE_PREFIX = '04-Archive';

/**
 * True once an event's month has fully passed relative to `now` — i.e. the
 * event is not in the current month or any future month.
 *
 * This is a whole-month comparison, not a day-count threshold: an event
 * dated earlier THIS month is not archived yet — it archives at the start
 * of next month, once its entire month is over. That matches the
 * {Calendar}/YYYY/MM/ folder layout (§ Master doc: shorten the list in the
 * active Calendar folder without losing anything or breaking sort order).
 *
 * Accepts either a date ("YYYY-MM-DD") or a dateTime ("YYYY-MM-DDTHH:MM...")
 * string — only the first 7 characters (YYYY-MM) are read.
 */
export function isPastMonth(isoDateOrDateTime: string, now: Date = new Date()): boolean {
  const eventMonth = isoDateOrDateTime.slice(0, 7); // "YYYY-MM"
  const nowMonth = now.toISOString().slice(0, 7);
  return eventMonth < nowMonth;
}
