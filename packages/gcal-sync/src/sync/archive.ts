import { sanitizeTitle } from '../markdown/paths.js';

/** The folder that mirrors {Tasks} and {Calendar} for finished tasks and past events. */
export const ARCHIVE_PREFIX = '04-Archive';

/**
 * True once the month of `isoDateOrDateTime` is over: a whole-month comparison, not a day count. An event from
 * earlier this month stays active until the month ends, so the active {Calendar} folder holds exactly the current
 * and future YYYY-MM folders. Only the first seven characters (YYYY-MM) of the date or dateTime are read, and
 * `now` is compared by its UTC month.
 */
export function isPastMonth(isoDateOrDateTime: string, now: Date = new Date()): boolean {
  const eventMonth = isoDateOrDateTime.slice(0, 7);
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
