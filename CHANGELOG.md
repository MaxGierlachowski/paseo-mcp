# Changelog

## 0.3.0 (unreleased)

Agent events: push instead of polling.

- **EventHub** with normalized events (`agent.created`, `turn_started`, `turn_ended` with outcome
  finished/error/limit/canceled, `permission_requested`, `permission_resolved`, `archived`, `closed`),
  a cursor `<epoch>:<seq>`, a bounded buffer (1000 events, 60 min) and `gap: true` plus the current
  state when a cursor is too old or from before a restart. Message content only as an opt-in,
  untrusted preview.
- **Two sources:** the plugin's lifecycle hooks and the daemon's agent push updates (also in stdio
  mode); the same happening is reported once.
- **`paseo_wait_for_events`** (read scope): long-poll with cursor and filters. `paseo_list_agents`
  returns `events_cursor`.
- **Resources** `paseo://agents` and `paseo://agents/{id}` with `resources/subscribe`,
  `notifications/resources/updated` and `list_changed`; resumable SSE (`Last-Event-ID`) over HTTP.
- **Webhooks** (plugin): several endpoints with filters, HMAC-SHA256 signatures, delivery id for
  idempotency, retries with backoff, optional bundling, auto-pause, test button, recent deliveries.
  Secrets stay on the daemon and are shown once.
- **Per-token label filter** for events and resources (e.g. only `origin=hermes`).
- stdio connects to the daemon at start; `events` block in `config.json`.

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
