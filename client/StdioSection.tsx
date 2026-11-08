// stdio clients: the stable command, a connection test, what the stdio server reads and how it signs
// in, and ready-made client configs. The stdio server keeps its own config file; nothing here edits it.
import { Fragment, useEffect, useState } from "react";
import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { probeRpc, stdioStatusRpc, type ProbeView, type StdioStatusView } from "../shared/rpc.js";
import { Block, CodeBlock, type Colors } from "./parts.js";

const AUTH_LABEL: Record<StdioStatusView["auth"]["mode"], string> = {
  open: "Daemon without password",
  "local-credential": "Signs in with Paseo's local credential",
  "password-in-config": "Password from the config file",
  "missing-credential": "No credential found",
};

const AUTH_HINT: Record<StdioStatusView["auth"]["mode"], string> = {
  open: "Loopback connections need no secret. The server still sends the local credential, so setting a password later keeps it working.",
  "local-credential": "Read from $PASEO_HOME/local-credential on every connect, like the paseo CLI. Paseo rotates it on restart; nothing to copy.",
  "password-in-config": "The config file sets a password, which wins over the local credential.",
  "missing-credential": "The daemon has a password but local-credential is missing. Restart Paseo or put the password in the config file.",
};

const LAUNCHER_HINT: Record<StdioStatusView["launcher"]["status"], string> = {
  written: "Launcher updated to this version of the plugin.",
  unchanged: "Launcher points at this version of the plugin and follows updates.",
  "foreign-file": "A file not written by this plugin is in the way; clients use the checkout path instead, which changes on updates.",
  "plugin-not-found": "The plugin checkout was not found in the Paseo config.",
};

function probeText(result: ProbeView): string {
  if (!result.ok) return result.error ?? "failed";
  return `${result.tools ?? "?"} tools, ${result.agents ?? "?"} agents listed, ${(result.ms / 1000).toFixed(1)} s`;
}

export function StdioSection({ rpc, colors }: { rpc: PluginCommandCapabilities["rpc"]; colors: Colors }) {
  const [view, setView] = useState<StdioStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<ProbeView | null>(null);

  useEffect(() => {
    rpc(stdioStatusRpc, {}).then(setView, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function test() {
    setProbing(true);
    setResult(null);
    try {
      setResult(await rpc(probeRpc, {}));
    } catch (e) {
      setResult({ ok: false, tools: null, agents: null, ms: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setProbing(false);
    }
  }

  const config = view?.config;
  const configHint = config
    ? config.exists
      ? [
          config.allowedRoots.length ? `Allowed roots: ${config.allowedRoots.join(", ")}` : null,
          config.accounts.length ? `Accounts: ${config.accounts.join(", ")}` : null,
          config.readOnly ? "Read-only" : null,
          config.path,
        ]
          .filter(Boolean)
          .join(" · ")
      : `${config.path} does not exist yet. Copy config.example.json from the plugin there.`
    : "";

  return (
    <>
      <SettingsSection
        title="stdio clients"
        info="Clients that start the server as a child process (Hermes with command:, Claude Code, any stdio client) don't need the HTTP server or a token. They read ~/.config/paseo-mcp/config.json, not the settings above."
      >
        <SettingsCard>
          {error ? <SettingsRow label="Could not load the stdio status" error={error} /> : null}
          {view ? (
            <>
              <SettingsRow label="Command" hint={LAUNCHER_HINT[view.launcher.status]} />
              {view.command ? (
                <Block>
                  <CodeBlock colors={colors} text={view.command} copyLabel="Copy command" />
                </Block>
              ) : null}
              <SettingsAction
                label={view.built ? "Test connection" : "Not built"}
                hint={result ? undefined : "Starts the server like a client, lists the tools and the agents."}
                error={result && !result.ok ? probeText(result) : view.built ? null : "dist/ is missing; run npm run build in the plugin checkout"}
                actionLabel={probing ? "Testing…" : "Test"}
                disabled={probing || !view.built || !view.command}
                onPress={() => void test()}
              />
              {result?.ok ? <SettingsRow label="Connection works" hint={probeText(result)} /> : null}
              <SettingsRow label="Config file" hint={configHint} error={config?.error ?? null} />
              <SettingsRow
                label={AUTH_LABEL[view.auth.mode]}
                hint={[AUTH_HINT[view.auth.mode], view.auth.masked].filter(Boolean).join(" · ")}
              />
            </>
          ) : error ? null : (
            <SettingsRow label="Loading…" />
          )}
        </SettingsCard>
      </SettingsSection>
      {view?.snippets.length ? (
        <SettingsSection title="stdio client configs">
          <SettingsCard>
            {view.snippets.map((snippet) => (
              <Fragment key={snippet.id}>
                <SettingsRow label={snippet.label} hint={snippet.hint} />
                <Block>
                  <CodeBlock colors={colors} text={snippet.text} copyLabel={`Copy ${snippet.label}`} />
                </Block>
              </Fragment>
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </>
  );
}
