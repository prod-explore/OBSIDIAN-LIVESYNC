# Security

## Supported versions

Only `main` is supported. There are no maintained release branches; fixes land on `main` and in the next tag.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository
(private vulnerability reporting). Do not open a public issue for something that could be exploited.

Include what you ran, what happened and what you expected; a failing test or a request that reproduces it is ideal.
I aim to answer within a week. Fixed issues are credited in the [CHANGELOG](CHANGELOG.md) unless you
prefer not to be named.

## In scope

The code in this repository, as deployed with the files in it:

- **The MCP server** (`packages/mcp`): authentication of `/mcp/` (token handling, comparison, what reaches the log),
  the path guard (`resolveVaultPath()`: escaping the vault through `..`, absolute paths or symbolic links, reaching
  hidden folders such as `.obsidian/`), and any tool that destroys data without a way back.
- **The Google sync** (`packages/gcal-sync`): anything that makes it delete or overwrite data on Google or in the vault
  that the user did not delete or change, or that writes outside the vault.
- **Secrets in logs**: a token, password or Google credential written by either service's logger.
- **The deployment files**: `docker-compose.yml`, the Dockerfiles and `deploy/nginx-obsidian.conf.example`, where a
  default exposes more than the README says.

## Keys

Generate `MCP_API_KEY` and every other secret in `.env` with `openssl rand -hex 32`. Hex needs no encoding in a URL,
which matters because the key may travel as `?token=`.

## Out of scope

- CouchDB, Obsidian, the Self-hosted LiveSync plugin, nginx and Google's APIs themselves: report those upstream.
- What an AI client does with access it was legitimately given (an agent told to rewrite a note rewrites it).
  The design limits that access; it does not judge intent.
- A host that is already compromised, or a `.env` that was shared.
