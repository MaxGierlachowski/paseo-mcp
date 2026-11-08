# How the plugin works

The README covers installing and using paseo-mcp. This page is for reading the code.

## Two entry points, one set of tools

- `server/tools.ts` registers the ten `paseo_*` tools on any `McpServer`. It gets a config getter,
  a function returning a connected `PaseoApi`, and a scope.
- `server/index.ts` is the stdio server (`dist/index.js`): config file, one `@getpaseo/client`
  connection, stdin/stdout.
- `index.server.ts` is the plugin's daemon side: settings, the HTTP server, the launcher and the
  RPCs the settings screen calls. `index.client.tsx` registers the settings screen and the ⌘K item.

Paseo bundles plugin modules only from `client/`, `server/` and `shared/`, so all source lives there;
`tsc` builds `server/*.ts` (not `server/plugin/`) into `dist/`.

## HTTP server (`server/http.ts`, `server/auth.ts`)

Every request passes, in order: path `/mcp`, `Host`, `Origin`, bearer token, body size. A new
session (an `initialize` without `Mcp-Session-Id`) gets its own `McpServer` with the tools of its
token's scope; later requests must come with the same token. Sessions idle for an hour are closed.

## Settings (`shared/settings.ts`, `server/plugin/runtime.ts`)

The settings document is stored by the Paseo host. The daemon side can read and subscribe to it but
not write it, so:

- a token is created by an RPC that returns the token and its record; the screen stores the record
  (hash only) and shows the token once;
- when a token was last used lives in `$PASEO_HOME/paseo-mcp.json`.

Every change runs through one queue: enable/port/bind restart the listener, removed or changed
tokens lose their sessions, a readOnly switch closes all sessions (their tool set is fixed at
initialize). Everything else is read on each tool call.

## Reaching the daemon

The SDK hands out a `PaseoApi` only inside hook and RPC handlers. MCP requests arrive on the plugin's
own listener, so `server/plugin/daemon.ts` keeps one loopback connection, made like the `paseo` CLI:
address from `$PASEO_HOME/paseo.pid`, credential from `$PASEO_HOME/local-credential`. The stdio server
uses the same credential when its config has no password.

## Launcher (`server/plugin/launcher.ts`)

Git installs land in a new versioned folder on every update. On every load the plugin finds its
checkout (the configured plugin directory whose manifest has id `paseo-mcp`) and writes
`~/.local/bin/paseo-mcp` pointing at `bin/paseo-mcp` there. A file without the marker line
`# managed-by: paseo plugin paseo-mcp` is never touched. The plugin build (`npm ci`, `npm run build`,
`npm prune --omit=dev`) produces the `dist/` it starts.

## Safe to load

No agent hooks, so installing, reloading or removing the plugin never marks open agent sessions
stale. The Test button starts its own short-lived stdio process and does not touch running clients.
