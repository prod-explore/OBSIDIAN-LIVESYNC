# Operations

Notes for running the stack. Setup itself is in the [README](../README.md).

## What lives where

| Host path | Holds | Back it up? |
|---|---|---|
| `./vault/vault-mcp` | The notes as Markdown files (what the MCP server and the sync read and write) | Yes |
| `./data` | CouchDB: the LiveSync database every device syncs with | Yes |
| `./gcal-sync-state` | `sync-state.json`: Google sync tokens and the manifest of known task/event ids | Yes (losing it means a full re-sync, not data loss) |
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
  path). Copy it back out; the folder is hidden from the vault tree, folder listings and search.
- `edit_note` rewrites a note in place without keeping the previous version. LiveSync's own history, or the backup, is the way back.
- The `.trash/` folder is never emptied by this project.

## Calendar & Tasks sync

- **Mass-deletion guard.** When most of a list's notes disappear from the vault in a single cycle (more than five, and more
  than half of what the sync knows about), the sync deletes nothing on Google and logs
  `[Push] Refusing to delete N of M known records ...`. That pattern is what an unmounted volume or a LiveSync fetch in progress
  looks like. If the deletion was intended, set `ALLOW_MASS_DELETE=true` in `.env`, run `docker compose up -d obsidian-gcal-sync`,
  wait one cycle, then remove the variable. Google Tasks has no undo for a deleted task.
- **State file.** `sync-state.json` is written atomically. If it is ever unreadable as JSON it is renamed to
  `sync-state.json.corrupt-<timestamp>` and the next cycle starts from an empty state (a full re-sync); a file that cannot be
  read at all stops the cycle instead.
- **Stopping.** `docker compose stop obsidian-gcal-sync` lets a running cycle finish (up to 15 seconds) so a note is never cut
  off mid-write.
- **Logs.** `docker logs -f obsidian-gcal-sync`. Each cycle prints what it ingested, pushed and archived.

## MCP server

- **Health.** `GET /mcp/health` (with the token) reports `status`, the vault path, whether it exists and the number of open SSE
  sessions. The image's `HEALTHCHECK` calls it, so `docker ps` shows `healthy`.
- **Token in the URL.** Some clients can only configure a URL, so the token may travel as `?token=`. Query strings end up in
  proxy logs; [`deploy/nginx-obsidian.conf.example`](../deploy/nginx-obsidian.conf.example) logs the path only for `/mcp/`.
  nginx's error log still prints the full request line when an upstream error happens, so prefer the `Authorization` header
  wherever the client allows it, and rotate `MCP_API_KEY` if a log leaves the machine.
- **Settings.** `MCP_API_KEY` (required), `VAULT_PATH`, `PORT` (3000), `TRASH_DIR` (`.trash`), `SSE_SESSION_MAX_AGE_MS` (1 h),
  `SSE_SWEEP_INTERVAL_MS` (5 min), `MCP_INSTRUCTIONS` (see `.env.example`).
- **Rebuild after an update.** `docker compose up -d --build obsidian-mcp obsidian-gcal-sync`.
