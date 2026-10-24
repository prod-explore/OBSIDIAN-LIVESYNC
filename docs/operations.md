# Operations

Notes for running the stack. Setup itself is in the [README](../README.md).

## What lives where

| Host path | Holds | Back it up? |
|---|---|---|
| `./vault/vault-mcp` | The notes as Markdown files (what the MCP server and the sync read and write) | Yes |
| `./data` | CouchDB: the LiveSync database every device syncs with | Yes |
| `./gcal-sync-state` | `sync-state.json`: Google sync tokens and the manifest of known task/event ids; `status.json`: how the last cycle went | Yes (losing it means a full re-sync, not data loss) |
| `./config` | Headless Obsidian's application settings (its list of vaults, window state); the vault's own `.obsidian/` folder, plugin settings included, lives in the vault | Yes |
| `.env` | Every secret | In a password manager, not next to the data |

Nothing here is backed up automatically. A nightly snapshot of the four folders is the minimum; for example
`tar czf /backups/obsidian-$(date +%F).tgz vault data gcal-sync-state config` from cron, with the file moved off the machine.
CouchDB is easiest to copy while `obsidian-couchdb` is stopped.

## File ownership

Headless Obsidian runs as uid 1000 (`PUID`/`PGID`), so everything that writes into the vault must too. `obsidian-mcp` and
`obsidian-gcal-sync` are pinned to `user: "1000:1000"` in `docker-compose.yml`, and their images run as the unprivileged
`node` user. A container writing as root creates folders Obsidian cannot write into (`EACCES`), which shows up as LiveSync
files stuck as "possibly unprocessed". If it happens anyway: `chown -R 1000:1000 vault`.

## Setting up the vault

The MCP server and the sync both read `/vault/vault-mcp` inside their containers, so the vault in headless Obsidian is the
folder `vault-mcp` inside `/vault`. To get at the GUI the first time, uncomment the `ports:` block of `obsidian-headless` in
`docker-compose.yml` (it binds to `127.0.0.1` only), open an SSH tunnel (`ssh -L 3000:localhost:3000 user@server`), then:

1. Create the vault `vault-mcp` in `/vault`.
2. Install **Self-hosted LiveSync** and point it at `http://obsidian-couchdb:5984` with your CouchDB credentials.
3. **Fetch** to pull the notes from the database.

Afterwards comment the `ports:` block out again and `docker compose up -d`.

If the LiveSync log reports config rule violations (`handleFilenameCaseSensitive`, `usePluginSyncV2`, `customChunkSize`),
make those settings identical on every device and on the headless instance.

## Recovering notes

- `delete_note`, and `write_note`/`move_note` with `overwrite`, move the old file into `.trash/` (name: timestamp + flattened
  path). Copy it back out on the host; the folder is hidden from the vault tree, folder listings and search, and no
  tool can read or write it (hidden paths such as `.trash/` and `.obsidian/` are refused).
- `edit_note` rewrites a note in place without keeping the previous version. LiveSync's own history, or the backup, is the way back.
- The `.trash/` folder is never emptied by this project.

## Calendar & Tasks sync

- **Health.** The container has a health check: it is `healthy` while the last successful cycle is recent (three polls plus five
  minutes), whatever single cycles did in between.
  `docker inspect --format '{{json .State.Health}}' obsidian-gcal-sync` shows the verdict and the reason (for example
  `last successful sync was 42 minutes ago (limit 20). Last error: Could not pull calendar primary: invalid_grant`).
  The detail is in `gcal-sync-state/status.json`: `lastSuccessAt`, `errors` and `lastError` of the latest cycle, and `problems`.
- **Notes that need fixing.** `problems` in `status.json` lists notes the sync leaves alone until someone looks at them, with the
  reason: a `due` or `start` that is not a date, a `status` Google does not know, an event note without `start`, front matter
  that is not valid YAML. They do not make the container unhealthy, and they do not hold up other notes. While a note cannot be
  read at all (broken YAML), the sync deletes nothing on Google, because a note it cannot read looks the same as a deleted one.
- **Duplicates.** Two notes with the same `google_id` are reduced to one: the one changed last stays, the other is moved to
  `_Systems/duplicates/<time>-<path>` and entered in `_Systems/sync-conflicts.md`. Look there before deleting the folder.
- **Cancelled notes.** `CANCELLED_RETENTION_DAYS` (default 30, `0` = keep for ever): a cancelled note with an empty body, no
  local edit waiting and a Google `updated` date older than that, is removed (deleted from disk, not moved). The count of removed notes is in the log and in `status.json` (`removedCancelled`).
- **Mass-deletion guard.** When most of a list's notes disappear from the vault in a single cycle (more than five, and more
  than half of what the sync knows about), the sync deletes nothing on Google and logs
  `Refusing to delete N of M known tasks in <list> ...` and counts it as an error. The cycle then does not count as a
  success, so once that has lasted past the health limit (three polls plus five minutes) the health check turns red.
  That pattern is what an unmounted volume or a LiveSync fetch in progress looks like. If the deletion was intended, set `ALLOW_MASS_DELETE=true` in `.env`, run `docker compose up -d obsidian-gcal-sync`,
  wait one cycle, then remove the variable. Google Tasks has no undo for a deleted task.
- **State file.** `sync-state.json` is written atomically. If it is ever unreadable as JSON it is renamed to
  `sync-state.json.corrupt-<timestamp>` and the next cycle starts from an empty state (a full re-sync); a file that cannot be
  read at all stops the cycle instead.
- **Stopping.** `docker compose stop obsidian-gcal-sync` lets a running cycle finish (up to 15 seconds) so a note is never cut
  off mid-write.
- **Logs.** `docker logs -f obsidian-gcal-sync`. One JSON object per line (`time`, `level`, `msg`, and fields such as `path` or
  `googleId`); `LOG_FORMAT=text` for reading at a terminal, `LOG_LEVEL=debug|info|warn|error|silent`. Each cycle logs when it
  starts and how it finished (`errors`, `durationMs`); changes are logged as they are made. Handy with `jq`:
  `docker logs obsidian-gcal-sync 2>&1 | jq -r 'select(.level != "info") | [.time, .msg, .error] | @tsv'`.

## MCP server

- **What a client can reach.** Only files and folders inside the vault whose path has no hidden part: `..`, absolute paths,
  links that lead out or into a hidden folder, `.obsidian/` and `.trash/` are refused. Only one note at a time is written,
  moved or deleted; a folder is refused.
- **Health.** `GET /mcp/health` (with the token) reports `status`, the vault path, whether it exists and the number of open SSE
  sessions. The image's `HEALTHCHECK` calls it, so `docker ps` shows `healthy`.
- **Token in the URL.** Some clients can only configure a URL (the "custom connector" form of Claude has just a name and a URL),
  so the token may travel as `?token=`. The MCP server itself never logs a query string, and its logger masks `token=` wherever it
  appears. Proxies are the other place: [`deploy/nginx-obsidian.conf.example`](../deploy/nginx-obsidian.conf.example) logs the path
  only for `/mcp/`. nginx's error log still prints the full request line when an upstream error happens, so prefer the
  `Authorization` header wherever the client allows it, and rotate `MCP_API_KEY` if a log leaves the machine.
- **Logs.** `docker logs obsidian-mcp`: JSON lines like the sync's. A request with a missing or wrong token is logged as a warning with
  its method, status and path (`LOG_LEVEL=error` silences it); so is a body that is not valid JSON or is larger than
  express's default limit of 100 kB (`Rejected a request body`, with `type` saying which).
- **Settings.** `MCP_API_KEY` (required), `VAULT_PATH`, `PORT` (3000), `TRASH_DIR` (`.trash`), `SSE_SESSION_MAX_AGE_MS` (1 h),
  `SSE_SWEEP_INTERVAL_MS` (5 min), `LOG_LEVEL`, `MCP_INSTRUCTIONS` (the line sent to clients on connect; unset = a pointer to `_Systems/AGENTS.md`, `none` = nothing).
- **Rebuild after an update.** `docker compose up -d --build obsidian-mcp obsidian-gcal-sync`.
