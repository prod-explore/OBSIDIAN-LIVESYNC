# Google Calendar & Tasks sync

How `obsidian-gcal-sync` maps Google Calendar events and Google Tasks to notes, and the rules it follows when the two
sides disagree. Running it (health, logs, recovery) is in [operations.md](operations.md).

## Folders

The sync works inside the vault (`VAULT_PATH`, `/vault/vault-mcp` in the container). The folder names are fixed.

| Path | Holds |
|---|---|
| `{Tasks}/` | Open tasks of the default Google Tasks list |
| `{Tasks}/<List name>/` | Open tasks of any other list; one folder per list, named after it |
| `{Calendar}/YYYY-MM/` | Events of the current and future months |
| `04-Archive/{Tasks}/...` | Completed and cancelled tasks, same subfolder as their list |
| `04-Archive/{Calendar}/YYYY-MM/` | Events of months that are over (by UTC month) |
| `_Systems/sync-conflicts.md` | Log of every decision the sync made against a local edit |
| `_Systems/duplicates/` | Copies set aside when two notes carried the same `google_id` |

Calendars are pulled only when they are listed in `CALENDAR_IDS`. Task lists are not configured: every list in the account
is synced, and the lists and the subfolders of `{Tasks}/` are kept in step like the notes.

## Task lists and folders

Each Google Tasks list other than the default one is a subfolder of `{Tasks}/` (nested folders belong to the list of their
first level). At the start of each cycle, before any task is pulled:

- A list made in Google gets its folder, even while it is empty. A folder made in `{Tasks}/` gets a list, even while it is
  empty.
- Two lists whose names make the same folder name (after cleaning, see File names) get one folder each: the one the sync
  recorded first keeps the name, the next gets `<name> (2)`, then `(3)`, and each keeps its folder from then on.
- A list renamed in Google has its folder and its `04-Archive/{Tasks}/` mirror renamed. If a folder with the new name is
  already there, nothing is merged: the list's folder gets the next free number, `<new name> (2)`.
- A folder renamed in the vault renames its list in Google, when the folder of a list is gone and that list's notes
  (by `tasklist_id`) are all in one new folder. The tasks keep their ids, and the archive mirror is renamed too.
- When a list is renamed on both sides in one cycle, Google's name wins, and only the name: the list stays the same list
  and its tasks keep their ids. The folder renamed in the vault (the one that now holds the list's notes) is moved, with
  everything in it, to Google's name, numbered as above if that name is taken, and so is the archive mirror. Nothing is
  created in Google. If no folder holds the list's notes and the vault was not fully readable, the list waits: its tasks
  are not pulled that cycle.
- A folder under `04-Archive/{Tasks}/` never creates a list: archived means archived. A note in it is pushed to the list
  its folder name stands for; when there is none, the note stays as it is and is listed under `problems`.
- Deletions carry across both ways. A folder deleted in the vault deletes its list in Google (with its tasks), and the
  folder's archive mirror goes to the trash. A list deleted in Google moves its folder and archive mirror, notes and all,
  to the trash (`TRASH_DIR`, `.trash/` by default, the MCP server's trash; named `<timestamp>__<path with / as __>`, as
  its `delete_note` names things); nothing in the vault is
  removed for good. Emptiness is not deletion: an empty folder or an empty list stays, empty, on both sides.
- A deletion only carries across when the sync is sure: the list is in its recorded mapping, Google's task lists were
  listed this cycle, and every task note could be read. A folder deleted in the vault also needs `{Tasks}/` itself to
  be there, and when more than five list folders and more than half of them vanish at once nothing is deleted and the
  cycle counts as failed, as with notes; `ALLOW_MASS_DELETE=true` for one cycle lets it through. Until then the
  deletion waits, the folder is not recreated, and the list's tasks are not pulled.
- If a list is renamed in Google while its folder was deleted in the vault, the rename wins and the folder is created
  again under the new name.
- Changes coming from the vault wait for a cycle in which every task note could be read.

Which folder stands for which list is remembered in `sync-state.json` (`tasklistFolders`), so a rename on one side is not
mistaken for a new list on the other.

File names:

- An event note is always at `{Calendar}/YYYY-MM/YYYY-MM-DD-HHMM-<Title>-<first 8 chars of the id>.md` (`HHMM` is `0000` for
  an all-day event). A new start or title renames the note, and `[[wikilinks]]` to the old name are rewritten in every note.
- A task note pulled from Google is named `<creation date>-<Title>-<first 8 chars of the id>.md` and keeps that name. A task
  note you create keeps the name you gave it.
- Titles are cleaned of characters that are illegal in file names and cut to 180 bytes. The full title stays in the front
  matter.
- Files named `README*` are never treated as notes.

## Note format

Only the front matter is synced. **The Markdown body is never sent to Google and never overwritten by it.** Google's own
description or notes field maps to the `description` property.

A task:

```yaml
---
title: Renew passport
status: needsAction        # needsAction | completed | cancelled
due: 2026-11-30            # YYYY-MM-DD
description: Synced to the task's notes in Google
---
Anything here stays in the vault.
```

An event:

```yaml
---
title: Dentist
start: 2026-11-12T09:30:00+01:00   # RFC 3339 date-time, or YYYY-MM-DD for an all-day event
end: 2026-11-12T10:15:00+01:00
status: confirmed                  # confirmed | tentative | cancelled
reminders: [10m, 1h]               # or: default, or [] / false for none
calendar_id: primary               # optional; the first of CALENDAR_IDS when absent
---
```

To create an item in Google, write a note with these properties in `{Tasks}/` (or a list subfolder) or anywhere under
`{Calendar}/`. An event needs `start`. On the next cycle the sync creates the item and adds the properties it maintains
itself: `type`, `google_id`, `tasklist_id` / `calendar_id`, `source`, `updated`, `synced_at` and `sync_hash`. Leave those
alone. Any other property you add is kept.

Values are checked before use. A note with a `due` or `start` that is not a date, a `status` Google does not know, or
front matter that is not valid YAML is skipped and listed under `problems` in `gcal-sync-state/status.json`; the other notes
are still synced.

## One cycle

Every `POLL_INTERVAL_MINUTES` (default 5), and once at start-up. Cycles never overlap.

1. **Pull.** Calendars are read incrementally with Google's sync token; an expired token (HTTP 410) starts a full sync.
   Task lists are read with an `updatedMin` watermark. Either marker only moves forward after a pass with no failure, so an
   item that could not be written is fetched again next time. The first calendar sync looks back 7 days; event instances
   more than 730 days ahead are ignored (recurring events are expanded into one note per instance).
2. **Push.** Notes that are new or edited since the sync last wrote them are created or patched in Google.
3. **Delete.** An id the sync knows about whose note is gone from the vault is deleted in Google (see the guards below).
4. **Tidy.** Completed tasks move to the archive and back if re-opened; events of finished months move to the archive;
   expired cancelled notes are removed.
5. **Save** `sync-state.json` (atomically) and write `status.json`.

## How changes are detected

A note's own edits are detected from its content, not from the file time: the sync stores an MD5 hash of the synced fields
(`title`, `status`, `due`, `start`, `end`, `description`) as `sync_hash`, and a note whose fields no longer match it has
been edited. File times are unreliable here because LiveSync rewrites files it only re-downloaded.
A note without `sync_hash` (written by hand or by another app) falls back to its file time: it counts as edited when the
file is more than two seconds newer than its `synced_at`, and as unchanged when it has no `synced_at` either. The next
write by the sync gives it a hash.

## Conflicts

When a note was edited locally and Google changed the same item:

- If the note's file time is newer than Google's `updated`, the note wins and is pushed.
- Otherwise Google wins. The losing front matter is appended to `_Systems/sync-conflicts.md` in full, so nothing typed is
  lost without a record.

## Deletions and their guards

Deleting a note deletes the item in Google. Because Google Tasks has no undo, three things stop a deletion that looks like a
fault rather than a decision:

- **Incomplete scan.** If any file or folder under the synced folders could not be read or parsed, no deletion runs that
  cycle. A note the sync cannot read looks the same as a deleted one.
- **Mass deletion.** When more than five ids, and more than half of what the sync knows about one list or calendar, vanish
  in one cycle, nothing is deleted and the cycle counts as failed. That is what an unmounted volume or a LiveSync fetch in
  progress looks like. `ALLOW_MASS_DELETE=true` for one cycle lets an intended bulk deletion through.
- **Already gone.** A 404 or 410 from Google on delete counts as done.

A task or event deleted or cancelled in Google is not deleted in the vault: its note is marked `cancelled` and moved to the
archive. After `CANCELLED_RETENTION_DAYS` (default 30, `0` = never) such a note is removed, but only if its body is empty
and it has no unpushed edit.

## Crash safety

- A new item is created with a `push_pending: true` marker written to the note first. A crash between the API call and
  saving the id is recognised on the next cycle and the insert is retried; the worst case is one extra item in Google.
- Notes are written in place before they are moved, so a crash leaves a correct note at the old path.
- Two notes with one `google_id` (an interrupted move, a copied note, a LiveSync conflict copy) are reduced to one: the one
  changed last stays, the other is moved to `_Systems/duplicates/` and logged, never deleted.
- `sync-state.json` that is not valid JSON is moved aside and the next cycle runs a full sync.

## Behaviour worth knowing

- Moving a task note to another list's folder deletes the task in the old list and creates it in the new one, with a new
  Google id.
- Google Tasks only knows `needsAction` and `completed`. A task note marked `cancelled` keeps that state in the vault only.
- Google is polled; there are no push notifications, so a change made in Google appears after at most one poll interval.
- The sync's path check is lexical: it keeps every path inside the vault but, unlike the MCP server's guard, does not
  inspect symbolic links.
