# Changelog

## 0.2.0 (unreleased)

Paseo plugin mode, which replaces the earlier local "Paseo MCP for Hermes" plugin build.

- **Streamable HTTP** at `/mcp` from inside the Paseo daemon, one MCP session per client. Off by
  default, binds to `127.0.0.1`.
- **Bearer tokens** per client with scope `read` (5 tools) or `full` (10), stored as SHA-256 hashes,
  revocable (open sessions end), per-token `origin` label. Host/Origin checks against DNS rebinding,
  1 MiB body limit.
- **Settings screen** (Settings → Plugins → paseo-mcp, ⌘K "MCP server"): server switch and status,
  port and bind address, tokens, allowed roots, defaults, accounts, copyable configs for Hermes and
  Claude Code (CLI and `.mcp.json`).
- **stdio through the plugin:** stable launcher `~/.local/bin/paseo-mcp` that follows plugin updates
  and never overwrites a foreign file, a Test button that starts the server like a client, config and
  sign-in status, copyable stdio configs.
- **stdio signs in with `local-credential`** when no password is configured (loopback only), so it
  keeps working when the daemon has a password.
- Tools moved to `server/tools.ts`, shared by both modes; names, schemas and behaviour unchanged.
  Source moved from `src/` to `server/`; `dist/index.js` stays.
- `npm test` (unit and HTTP integration tests), `npm run typecheck`; `smoke.mjs` takes
  `SMOKE_COMMAND` and fails on tool errors.

## 0.1.0 (2026-11-04)

- stdio MCP server with ten tools: list, read and start agents, send follow-ups, wait, answer
  permissions, archive. `allowedRoots`, `origin`/`account` labels, read-only mode.
