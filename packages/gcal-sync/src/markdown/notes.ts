/**
 * What a task note and an event note look like in the front matter, and how a parsed YAML block is turned into
 * one. YAML decides the type of every value on its own (`due: 2026-03-01` is a Date, `title: 2026` a number,
 * `google_id: 1234` a number), so nothing read from a note is used before it has been through here.
 *
 * Reading never throws and never discards the user's own properties: a value that cannot be a date or a known
 * status is left out of the typed note and reported in `problems`, so the caller can skip that one note and say why
 * instead of failing every cycle.
 */

/** Whatever the YAML parser returned. */
export type RawFrontmatter = Record<string, unknown>;

export const TASK_STATUSES = ['needsAction', 'completed', 'cancelled'] as const;
export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Fields both kinds of note share. Anything else the user adds to a note passes through untouched. */
export interface NoteFields extends RawFrontmatter {
  google_id?: string;
  title?: string;
  description?: string;
  source?: 'google' | 'obsidian';
  /** When Google last changed the item (or when the sync last wrote it). ISO 8601. */
  updated?: string;
  /** When the sync last wrote the note. ISO 8601. */
  synced_at?: string;
  /** Hash of the synced fields at that moment; a different hash now means someone edited the note. */
  sync_hash?: string;
  /** Written before an insert and cleared after it, so a crash in between can be recovered (see push). */
  push_pending?: boolean;
}

export interface TaskNote extends NoteFields {
  type?: 'task';
  tasklist_id?: string;
  status?: TaskStatus;
  /** YYYY-MM-DD */
  due?: string;
}

export interface EventNote extends NoteFields {
  type?: 'event';
  calendar_id?: string;
  status?: EventStatus;
  /** An RFC 3339 dateTime, or YYYY-MM-DD for an all-day event. */
  start?: string;
  end?: string;
  /** 'default', true/false/null, or a list like ['10m', '1h', '1d']; see events.ts for how it is read. */
  reminders?: unknown;
}

export interface Read<N> {
  note: N;
  /** Why the note cannot be synced as it is. Empty for a healthy note. */
  problems: string[];
}

// ── value coercion ──────────────────────────────────────────────────────────

function plainText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return undefined;
}

/** A point in time: YAML turns an unquoted ISO timestamp into a Date. */
function instant(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * A date or date-time as text: an RFC 3339 dateTime, or a plain date for an all-day value. Obsidian's date
 * property writes `2031-05-04` unquoted and YAML reads that as a Date at midnight UTC, which is a day, not an
 * instant, so it must not become "00:00".
 */
export function dateText(value: unknown): string | undefined {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  return undefined;
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === '';

function set(note: RawFrontmatter, key: string, value: unknown): void {
  if (value === undefined) delete note[key];
  else note[key] = value;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  const text = plainText(value);
  return text !== undefined && (allowed as readonly string[]).includes(text) ? (text as T) : undefined;
}

function commonFields(note: NoteFields, raw: RawFrontmatter): void {
  set(note, 'google_id', isEmpty(raw.google_id) ? undefined : plainText(raw.google_id));
  set(note, 'title', plainText(raw.title));
  set(note, 'description', plainText(raw.description));
  set(note, 'updated', instant(raw.updated));
  set(note, 'synced_at', instant(raw.synced_at));
  set(note, 'sync_hash', typeof raw.sync_hash === 'string' ? raw.sync_hash : undefined);
  set(note, 'source', oneOf(['google', 'obsidian'], raw.source));
  set(note, 'push_pending', raw.push_pending === true ? true : undefined);
}

function checkedStatus<S extends string>(note: RawFrontmatter, raw: RawFrontmatter, allowed: readonly S[], problems: string[]): void {
  if (isEmpty(raw.status)) {
    delete note.status;
    return;
  }
  const status = oneOf(allowed, raw.status);
  if (status === undefined) problems.push(`status "${String(raw.status)}" is not one of ${allowed.join(', ')}`);
  set(note, 'status', status);
}

function checkedDate(note: RawFrontmatter, raw: RawFrontmatter, key: string, hint: string, problems: string[]): void {
  if (isEmpty(raw[key])) {
    delete note[key];
    return;
  }
  const text = dateText(raw[key]);
  if (text === undefined || Number.isNaN(new Date(text).getTime())) {
    problems.push(`${key} "${String(raw[key])}" is not a date (${hint})`);
    delete note[key];
    return;
  }
  note[key] = text;
}

// ── readers ─────────────────────────────────────────────────────────────────

export function readTaskNote(raw: RawFrontmatter): Read<TaskNote> {
  const problems: string[] = [];
  const note: TaskNote = { ...raw };
  commonFields(note, raw);
  set(note, 'tasklist_id', isEmpty(raw.tasklist_id) ? undefined : plainText(raw.tasklist_id));
  checkedStatus(note, raw, TASK_STATUSES, problems);
  checkedDate(note, raw, 'due', 'write it as YYYY-MM-DD', problems);
  return { note, problems };
}

export function readEventNote(raw: RawFrontmatter): Read<EventNote> {
  const problems: string[] = [];
  const note: EventNote = { ...raw };
  commonFields(note, raw);
  set(note, 'calendar_id', isEmpty(raw.calendar_id) ? undefined : plainText(raw.calendar_id));
  checkedStatus(note, raw, EVENT_STATUSES, problems);
  checkedDate(note, raw, 'start', 'YYYY-MM-DD, or YYYY-MM-DDTHH:MM:SS+01:00', problems);
  checkedDate(note, raw, 'end', 'YYYY-MM-DD, or YYYY-MM-DDTHH:MM:SS+01:00', problems);
  return { note, problems };
}
