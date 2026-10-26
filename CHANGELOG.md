# Changelog

All notable changes. Format after [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Security
- **MCP: hidden paths are refused.** `resolveVaultPath()` refuses any path through a hidden file or folder, also behind a link. Before, `get_path` could read `.obsidian/plugins/obsidian-livesync/data.json` (the CouchDB password) and `write_note` could plant a plugin that headless Obsidian would run.
- **MCP: one note at a time.** `delete_note`, `write_note` (with `overwrite`) and `move_note` accepted a folder and trashed or moved it whole; they now refuse folders.
- **Logs:** secret-named fields are masked at any depth, `client_secret=`/`refresh_token=` and other secret URL parameters and secret keys quoted in JSON text are masked, and a field that refers to itself no longer makes the logger throw.
- `get-token` listens on `localhost` only.

### Added
- MCP: writes are rate limited (`MCP_WRITE_LIMIT_PER_MINUTE`, 120 by default, `0` = off): a client in a loop can no longer rewrite or trash a vault in seconds.
- MCP: `MCP_BODY_LIMIT` (5 MB by default). The 100 kB default of Express made `write_note` fail on a larger note.
- MCP: `edit_note` copies the note to `.trash/` before changing it, and `move_note` copies every note whose links it rewrites.

### Fixed
- MCP: `move_note` reported "Updated N backlink(s)" counting notes, and one note that could not be rewritten stopped the rest and was only logged. It now counts links and notes, rewrites every note it can, and names each note it could not.

### Changed
- Sync: `_Systems/sync-conflicts.md` records the whole front matter of the edit that lost, not only its title and time.
- MCP: a malformed or oversized request body is answered with JSON and one structured log line instead of Express's stack trace.
- MCP: clients see the package version in `serverInfo` (it said 1.1.0); a port that cannot be bound is logged and ends the process cleanly.
- Repository: SECURITY.md, .editorconfig, a CodeQL workflow; Dependabot groups image and Action updates and leaves Node majors to a decision.
- README: a one-minute local try-out of the MCP server, real test counts, the quick start starts the Google sync only once it is configured.

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
