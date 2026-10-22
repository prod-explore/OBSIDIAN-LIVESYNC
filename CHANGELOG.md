# Changelog

All notable changes. Format after [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [1.0.0] - 2026-10-22

The first tagged release: three parts (LiveSync, the MCP server, the Google Calendar & Tasks sync) in one npm workspace.

### Added
- **Sync: one item, one note.** Notes sharing a `google_id` are reduced to the one changed last; the others are moved to `_Systems/duplicates/` and logged.
- **Sync: cancelled notes expire** after `CANCELLED_RETENTION_DAYS` (default 30, `0` keeps them) when their body is empty.
- **Sync: `status.json` and a container health check** that is green while the last successful cycle is recent and says why when it is not.
- **Sync: typed notes** (`TaskNote`, `EventNote`) read through validators. A note with an impossible `due`, an unknown `status` or broken YAML is skipped and listed with its reason instead of failing every cycle.
- **Structured logging** in both services (`LOG_LEVEL`, `LOG_FORMAT`), masking `?token=`, bearer tokens and secret-named fields.
- MCP: tests for `write_note`, `delete_note`, `move_note`, `get_path` and `get_vault_tree` against a real temporary vault.
- Tooling: type-aware ESLint (no `any`, no floating promises, no `console`), Prettier, c8 coverage floors, Dependabot, and CI jobs for lint, format, types, coverage and a check that both copies of `logger.ts` are identical.

### Changed
- Repository restructured into `packages/mcp` and `packages/gcal-sync` with one lockfile; Docker images are built from the repository root.
- `push.ts` (538 lines, functions of up to 11 parameters) became `sync/push/{tasks,events,folder}.ts`; every step takes one `SyncContext`.
- Deletions on Google are skipped for a cycle when part of the vault could not be read or parsed.
- `StateManager.save` throws when the state cannot be written; the cycle then counts as failed instead of silently losing progress.
- A task note marked `cancelled` is no longer sent to Google Tasks, which only knows `needsAction` and `completed`.
- MCP: `loadConfig` throws instead of exiting the process; async routes are wrapped so a rejection becomes a logged 500, not an unhandled rejection that ends the process.
- `couchdb:latest` is now `couchdb:3`.

### Fixed
- **Completing a task that lives in a list subfolder** archived the note flat; the next cycle then deleted the task in Google and created a new one with a new ID. It now stays in its list's folder under `04-Archive/{Tasks}/`, and keeps its ID.
- A `due` value that YAML reads as a date no longer differs from the one the sync wrote (a spurious "locally modified" on every cycle).
- A task-list lookup that fails is reported once per cycle, not once per note.

### Earlier
Work before the first tag (MCP server, LiveSync stack, the sync's ingest/push/archive design, the mass-deletion guard, token recovery, crash-safe inserts, the wikilink refactor on rename) is in the git history.
