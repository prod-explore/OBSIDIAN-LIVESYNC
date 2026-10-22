import { sanitizeTitle } from '../markdown/paths.js';

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
 * {Calendar}/YYYY-MM/ folder layout: the active Calendar folder only lists
 * the current and future months, without losing anything or breaking sort order.
 *
 * Accepts either a date ("YYYY-MM-DD") or a dateTime ("YYYY-MM-DDTHH:MM...")
 * string — only the first 7 characters (YYYY-MM) are read.
 */
export function isPastMonth(isoDateOrDateTime: string, now: Date = new Date()): boolean {
  const eventMonth = isoDateOrDateTime.slice(0, 7); // "YYYY-MM"
  const nowMonth = now.toISOString().slice(0, 7);
  return eventMonth < nowMonth;
}

/**
 * Where an event's note belongs: {Calendar}/YYYY-MM/YYYY-MM-DD-HHMM-Title-shortId.md, or the same path
 * under 04-Archive once its month is over. The date and time are Google's, as written in the event's start
 * (`startRaw`, "YYYY-MM-DD" or an RFC 3339 dateTime); HHMM is 0000 for all-day events, so notes sort
 * chronologically inside a month and across months. Ingest and push both use this, so they agree.
 */
export function eventNotePath(startRaw: string, title: string, googleId: string, now: Date = new Date()): string {
  const datePart = startRaw.slice(0, 10) || now.toISOString().slice(0, 10);
  const timePart = startRaw.includes('T') ? startRaw.slice(11, 16).replace(':', '') : '0000';
  const active = `{Calendar}/${datePart.slice(0, 4)}-${datePart.slice(5, 7)}/${datePart}-${timePart}-${sanitizeTitle(title)}-${googleId.substring(0, 8)}.md`;
  return isPastMonth(datePart, now) ? `${ARCHIVE_PREFIX}/${active}` : active;
}
