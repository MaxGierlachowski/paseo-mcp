// paseo-mcp as a Paseo plugin: the same tools as the stdio server, served over Streamable HTTP
// from inside the daemon and configured on the plugin's settings screen, plus agent events.
//
// Agent hooks: only observing lifecycle hooks (create/turn/permission/archive/close). No
// session-open hook, so loading, reloading or removing the plugin never marks open sessions stale.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { newToken } from "./server/auth.js";
import {
  createTokenRpc,
  createWebhookRpc,
  probeRpc,
  resumeWebhookRpc,
  rotateWebhookSecretRpc,
  statusRpc,
  stdioStatusRpc,
  testWebhookRpc,
  webhookStatusRpc,
} from "./shared/rpc.js";
import { mcpSettings } from "./shared/settings.js";
import { McpRuntime, type HookReport } from "./server/plugin/runtime.js";
import { syncLauncher } from "./server/plugin/launcher.js";
import { probe, stdioStatus } from "./server/plugin/stdio.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(mcpSettings);
  const runtime = new McpRuntime();

  const onSettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") return runtime.apply(state.values);
    console.warn(`paseo-mcp: settings are invalid, keeping the previous ones: ${state.error}`);
  };

  // Hooks return at once; the event work runs in the background so no agent ever waits on it.
  const report = (r: HookReport, paseo: Parameters<McpRuntime["onHook"]>[1]) => {
    void runtime.onHook(r, paseo).catch((e: unknown) => console.warn({ err: e }, "paseo-mcp: hook event failed"));
    return Promise.resolve();
  };
  const cleanups = [
    settings.subscribe(onSettings),
    server.addHook("agent.create.after", async ({ agent }, { paseo }) =>
      report({ hook: "agent.create.after", agentId: agent.id, title: agent.title }, paseo),
    ),
    server.addHook("agent.turn.before", async ({ agent }, { paseo }) =>
      report({ hook: "agent.turn.before", agentId: agent.id, title: agent.title }, paseo),
    ),
    server.addHook("agent.turn.after", async ({ agent, outcome }, { paseo }) =>
      report({ hook: "agent.turn.after", agentId: agent.id, title: agent.title, outcome }, paseo),
    ),
    server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) =>
      report(
        {
          hook: "agent.permission.before",
          agentId: agent.id,
          title: agent.title,
          request: { id: request.id, name: request.name, title: request.title ?? null, kind: request.kind },
        },
        paseo,
      ),
    ),
    server.addHook("agent.permission.after", async ({ agent, requestId, resolution }, { paseo }) =>
      report(
        { hook: "agent.permission.after", agentId: agent.id, title: agent.title, requestId, behavior: resolution.behavior ?? null },
        paseo,
      ),
    ),
    server.addHook("agent.archive.after", async ({ agent }, { paseo }) =>
      report({ hook: "agent.archive.after", agentId: agent.id, title: agent.title }, paseo),
    ),
    server.addHook("agent.close.after", async ({ agent }, { paseo }) =>
      report({ hook: "agent.close.after", agentId: agent.id, title: agent.title }, paseo),
    ),
  ];
  void runtime.state
    .load()
    .then(() => settings.read())
    .then(onSettings)
    .then(() => runtime.start())
    .catch((e: unknown) => console.error({ err: e }, "paseo-mcp: could not read settings"));

  // stdio clients get a stable command that follows plugin updates.
  void syncLauncher()
    .then((state) => {
      if (state.status === "foreign-file") {
        console.warn(`paseo-mcp: ${state.launcherPath} exists and was not written by this plugin; left untouched`);
      } else if (state.status !== "plugin-not-found" && !state.built) {
        console.warn(`paseo-mcp: ${state.entry} is missing; run npm run build in the plugin checkout`);
      } else if (state.status === "written") {
        console.info(`paseo-mcp: launcher written at ${state.launcherPath}`);
      }
    })
    .catch((e: unknown) => console.error({ err: e }, "paseo-mcp: could not write the launcher"));

  server.handle(statusRpc, () => runtime.status());
  server.handle(stdioStatusRpc, () => stdioStatus());
  server.handle(probeRpc, async () => {
    const current = await stdioStatus();
    if (!current.command) return { ok: false, tools: null, agents: null, ms: 0, error: "plugin checkout not found" };
    if (!current.built) return { ok: false, tools: null, agents: null, ms: 0, error: "dist/ is missing; run npm run build" };
    return probe(current.command);
  });
  server.handle(createTokenRpc, (input) => newToken(input));
  server.handle(createWebhookRpc, (input) => runtime.createWebhook(input));
  server.handle(rotateWebhookSecretRpc, ({ id }) => runtime.rotateWebhookSecret(id));
  server.handle(testWebhookRpc, ({ id }) => runtime.testWebhook(id));
  server.handle(resumeWebhookRpc, ({ id }) => runtime.resumeWebhook(id));
  server.handle(webhookStatusRpc, () => runtime.webhookStatus());

  return async () => {
    for (const cleanup of cleanups) await cleanup();
    await runtime.stop();
  };
}
