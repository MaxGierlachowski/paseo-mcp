# Changelog

## 0.5.0

Paseo 0.17 and headless Linux hosts.

- **Paseo 0.17:** `@getpaseo/client` and `@getpaseo/plugin` pinned to 0.17.3; the plugin manifest
  requires `>=0.17.0 <0.18.0`.
- **Bare providers work again:** Paseo 0.17 wants `provider/model` for new agents. A bare provider
  (`defaultProvider: "claude"`, or `provider: "claude"` in `paseo_create_agent`) now gets the
  provider's default model instead of failing.
- **Release tarball:** `npm run release:tarball` builds `dist/paseo-mcp-<version>.tgz` (top-level
  `paseo-mcp/`) and a `sha256sum`-format `.sha256`. Self-contained (plugin sources, built stdio server,
  production `node_modules`, no native modules), so `paseo plugin install <dir>` and
  `node <dir>/dist/index.js` work offline on any platform. Reproducible from the same commit.
- **Managed settings file** for hosts without the Paseo app: `$PASEO_HOME/paseo-mcp.managed.json`
  (or `PASEO_MCP_MANAGED`) turns the HTTP server on and adds tokens and webhooks; watched and applied
  live, its values win over the settings screen, which shows that it is in use.
- **`paseo-mcp-admin`** (`dist/admin.js`): create, rotate, list and revoke tokens in that file
  non-interactively; the token is printed once or written to a file, only its hash is stored.
- **Headless Linux smoke test** (`scripts/linux-smoke.sh`), run in CI on Ubuntu 24.04 x64 and arm64:
  a real daemon (relay and web UI off), the plugin from the tarball, the HTTP endpoint per scope, an
  agent on a model-free ACP provider, events with `origin_ref`, a permission round trip, a verified
  Standard Webhooks delivery, live token revocation and the stdio server.
- README: "Headless Linux / agentbox" (install commands, endpoint, tokens, stdio config, webhooks);
  examples use generic paths.

## 0.4.0 (unreleased)

Webhooks any receiver can verify, and events that say who started an agent.

- **Signature schemes per webhook:** `paseo` (default, unchanged), `standard-webhooks`
  ([standardwebhooks.com](https://www.standardwebhooks.com/), Svix-compatible: `webhook-id`,
  `webhook-timestamp`, `webhook-signature`) and `github` (`X-Hub-Signature-256`, `X-GitHub-Event`,
  `X-GitHub-Delivery`). Receiver-side helpers `verifyStandardWebhook` and `verifyGithubSignature`.
- **Receiver-issued secrets:** create a webhook with, or switch it to, a secret the receiver gave you;
  it is never echoed back. Generated secrets are now `whsec_` + standard base64 (valid Standard
  Webhooks keys); a secret that does not fit the scheme is reported on the screen and fails deliveries
  with a readable error.
- **Custom headers** per webhook (e.g. `Authorization`), values kept on the daemon like secrets;
  transport and signing headers are protected.
- **Richer payloads:** every event has `cwd`, `provider` and a one-line `summary`; permission events
  carry `description` (untrusted, shortened) and `actions`. Deliveries add `source`, `version`, `type`,
  `summary` and `event` (the newest event) at top level for templates without array indexes.
- **Back-reference to the caller:** labels come back in every event; documented convention
  `origin_ref=<client session id>`, and `metaLabels` copies `_meta` fields of `tools/call` onto labels.
- Fixed: in stdio mode a permission request from a lagging snapshot had `requiresAttention: false`
  and was missed by `only_needs_attention`.
- Fixed: concurrent writes of the plugin's state file could fail on the shared temporary file.

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
