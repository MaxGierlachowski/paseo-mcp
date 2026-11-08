// Settings → Plugins → MCP server. Built from the host's settings components, so it looks like the
// rest of Settings and works on every client. Switches and lists save at once; text fields save
// with the Save action of their section.
import { Fragment, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { PluginCommandCapabilities, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  useToast,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { createTokenRpc, statusRpc, type McpStatus } from "../shared/rpc.js";
import { Block, CodeBlock, SmallButton } from "./parts.js";
import { StdioSection } from "./StdioSection.js";
import { EventsSection } from "./EventsSection.js";
import { DEFAULT_BIND, mcpSettings, type McpSettings, type StoredToken } from "../shared/settings.js";
import {
  TOKEN_PLACEHOLDER,
  ago,
  claudeCodeSnippet,
  claudeJsonSnippet,
  connectUrl,
  day,
  hermesSnippet,
  isLoopback,
  parseLabels,
  plural,
} from "./format.js";

type Rpc = PluginCommandCapabilities["rpc"];

const STATUS_POLL_MS = 5_000;

function scopeText(scope: StoredToken["scope"]): string {
  return scope === "full" ? "Full access" : "Read only";
}

export function makeMcpSettings(rpc: Rpc) {
  function McpSettingsScreen({ theme }: PluginSurfaceProps) {
    const { colors } = theme;
    const toast = useToast();
    const state = useSettings(mcpSettings);
    const [status, setStatus] = useState<McpStatus | null>(null);
    const [created, setCreated] = useState<{ token: string; label: string } | null>(null);
    const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [newScope, setNewScope] = useState<StoredToken["scope"]>("read");
    const [bindDraft, setBindDraft] = useState<string | null>(null);
    const draft = useRef<Record<string, string>>({});
    const inputs = useRef<Record<string, SettingsInputHandle | null>>({});

    useEffect(() => {
      let alive = true;
      const poll = () =>
        rpc(statusRpc, {}).then(
          (s) => alive && setStatus(s),
          () => alive && setStatus(null),
        );
      void poll();
      const timer = setInterval(() => void poll(), STATUS_POLL_MS);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, [state.status === "ready" ? state.revision : ""]);

    if (state.status === "loading") return <SettingsRow label="Loading…" />;
    if (state.status === "error") return <SettingsRow label="Could not load settings" error={state.error} />;
    if (state.status === "invalid") {
      return (
        <SettingsSection title="MCP server">
          <SettingsCard>
            <SettingsAction
              label="The stored settings are invalid"
              error={state.error}
              actionLabel="Reset"
              onPress={() => void state.reset()}
            />
          </SettingsCard>
        </SettingsSection>
      );
    }

    const values = state.values;
    const revision = state.revision;

    /** Saves a change against the document on screen. */
    async function update(change: (next: McpSettings) => void, success?: string): Promise<boolean> {
      // JSON round trip, not structuredClone: Hermes on the mobile apps may not have it.
      const next = JSON.parse(JSON.stringify(values)) as McpSettings;
      change(next);
      const saved = await state.save(next, revision);
      if (saved && success) toast.show(success, { variant: "success" });
      if (!saved) toast.error(state.saveError ?? "Could not save the settings");
      return saved;
    }

    const field = (key: string) => (text: string) => {
      draft.current[key] = text;
      if (key === "bind") setBindDraft(text.trim());
    };
    const take = (key: string): string | undefined => draft.current[key];
    const clearInput = (key: string) => {
      delete draft.current[key];
      inputs.current[key]?.replaceText("");
    };

    async function saveListener() {
      const portText = take("port");
      const bind = take("bind")?.trim();
      const port = portText === undefined ? values.http.port : Number(portText.trim());
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return toast.error("Port must be 1–65535");
      if (port === 6767) return toast.error("6767 is the Paseo daemon's own port");
      if (bind !== undefined && !bind) return toast.error("Enter a bind address, e.g. 127.0.0.1");
      const ok = await update((next) => {
        next.http.port = port;
        if (bind) next.http.bind = bind;
      }, "Saved; the server restarts on the new address");
      if (ok) {
        delete draft.current.port;
        delete draft.current.bind;
        setBindDraft(null);
      }
    }

    async function createToken() {
      const label = take("tokenLabel")?.trim();
      if (!label) return toast.error("Give the token a label, e.g. Hermes");
      const origin = take("tokenOrigin")?.trim() || undefined;
      const labelFilter = parseLabels(take("tokenFilter") ?? "");
      if (labelFilter === null) return toast.error("Label filter: key=value, separated by commas");
      setBusy(true);
      try {
        const { token, record } = await rpc(createTokenRpc, { label, scope: newScope, origin, labelFilter });
        const ok = await update((next) => {
          next.tokens.push(record);
        });
        if (ok) {
          setCreated({ token, label });
          clearInput("tokenLabel");
          clearInput("tokenOrigin");
          clearInput("tokenFilter");
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    }

    async function revoke(token: StoredToken) {
      setBusy(true);
      try {
        const ok = await update((next) => {
          next.tokens = next.tokens.filter((t) => t.id !== token.id);
        }, `Revoked ${token.label}; its sessions are closed`);
        if (ok) setConfirmRevoke(null);
      } finally {
        setBusy(false);
      }
    }

    async function saveDefaults() {
      const keys = ["defaultProvider", "defaultThinking", "defaultMode", "originLabel", "accountEnvVar"] as const;
      const ok = await update((next) => {
        for (const key of keys) {
          const text = take(key);
          if (text === undefined) continue;
          const value = text.trim();
          if (key === "accountEnvVar") next.accountEnvVar = value || "CLAUDE_CONFIG_DIR";
          else if (value) next[key] = value;
          else delete next[key];
        }
      }, "Saved");
      if (ok) for (const key of keys) delete draft.current[key];
    }

    async function addRoot() {
      const root = take("root")?.trim();
      if (!root) return;
      if (values.allowedRoots.includes(root)) return toast.error("Already in the list");
      if (await update((next) => void next.allowedRoots.push(root))) clearInput("root");
    }

    async function addAccount() {
      const name = take("accountName")?.trim();
      const configDir = take("accountDir")?.trim();
      const note = take("accountNote")?.trim();
      if (!name || !configDir) return toast.error("An account needs a name and a config directory");
      if (values.accounts[name]) return toast.error(`There is already an account "${name}"`);
      const ok = await update((next) => {
        next.accounts[name] = note ? { configDir, note } : { configDir };
      });
      if (ok) for (const key of ["accountName", "accountDir", "accountNote"]) clearInput(key);
    }

    const url = status?.url ?? connectUrl(values.http.bind, values.http.port);
    const snippetToken = created?.token ?? TOKEN_PLACEHOLDER;
    const shownBind = bindDraft ?? values.http.bind;
    const statusLabel = !values.http.enabled
      ? "Off"
      : status?.listening
        ? `Listening on ${status.url}`
        : status?.error
          ? "Not running"
          : "Starting…";
    const openSessions = status ? Object.values(status.sessions).reduce((a, b) => a + b, 0) : 0;
    const ref = (key: string) => (handle: SettingsInputHandle | null) => {
      inputs.current[key] = handle;
    };

    return (
      <>
        <SettingsSection
          title="HTTP server"
          info="Serves the Paseo MCP tools over Streamable HTTP at /mcp. Every request needs an access token, also from this machine."
        >
          <SettingsCard>
            <SettingsSwitch
              label="Enabled"
              hint="Off by default. Turning it on starts the server inside the Paseo daemon."
              value={values.http.enabled}
              onValueChange={(enabled) => void update((next) => void (next.http.enabled = enabled))}
              disabled={state.saving}
            />
            <SettingsRow
              label={statusLabel}
              hint={values.http.enabled && status?.listening ? plural(openSessions, "open session") : undefined}
              error={values.http.enabled ? status?.error : null}
            />
            <SettingsInput
              ref={ref("port")}
              label="Port"
              hint="Not 6767, which the daemon itself uses."
              initialValue={String(values.http.port)}
              placeholder="6790"
              onChangeText={field("port")}
            />
            <SettingsInput
              ref={ref("bind")}
              label="Bind address"
              hint={`${DEFAULT_BIND} keeps the server on this machine.`}
              initialValue={values.http.bind}
              placeholder={DEFAULT_BIND}
              onChangeText={field("bind")}
            />
            {isLoopback(shownBind) ? null : (
              <SettingsRow
                label="Reachable from other machines"
                error={`On ${shownBind} anyone on your network can reach the server; only the tokens protect it. Prefer ${DEFAULT_BIND} unless you know you need this.`}
              />
            )}
            <SettingsAction
              label="Apply port and address"
              actionLabel="Save"
              disabled={state.saving}
              onPress={() => void saveListener()}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          title="Access tokens"
          info="A client sends its token as Authorization: Bearer <token>. Read-only tokens see the list/read tools and events, full tokens also start and steer agents. Tokens are stored only as a SHA-256 hash; revoking one closes its open sessions."
        >
          <SettingsCard>
            {created ? (
              <>
                <SettingsRow
                  label={`New token for ${created.label}`}
                  hint="Copy it now. It is shown only this once and cannot be recovered."
                />
                <Block>
                  <CodeBlock colors={colors} text={created.token} copyLabel="Copy token" />
                </Block>
                <SettingsAction label="Copied it" actionLabel="Hide token" onPress={() => setCreated(null)} />
              </>
            ) : null}
            {values.tokens.length === 0 ? (
              <SettingsRow label="No tokens yet" hint="Create one below for each client." />
            ) : null}
            {values.tokens.map((token) => {
              const sessions = status?.sessions[token.id] ?? 0;
              const hint = [
                scopeText(token.scope),
                `created ${day(token.createdAt)}`,
                `last used ${ago(status?.lastUsed[token.id])}`,
                sessions ? plural(sessions, "open session") : null,
                token.scope === "full" ? `origin=${token.origin || values.originLabel || token.label}` : null,
                token.labelFilter
                  ? `sees only ${Object.entries(token.labelFilter).map(([k, v]) => `${k}=${v}`).join(" ")}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <Fragment key={token.id}>
                  <SettingsRow label={token.label} hint={hint}>
                    <SmallButton
                      colors={colors}
                      label="Revoke"
                      danger
                      disabled={busy || confirmRevoke === token.id}
                      onPress={() => setConfirmRevoke(token.id)}
                    />
                  </SettingsRow>
                  {confirmRevoke === token.id ? (
                    <SettingsRow
                      label={`Revoke ${token.label}?`}
                      hint="Clients using it get 401 from now on and their open sessions end."
                    >
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <SmallButton colors={colors} label="Cancel" disabled={busy} onPress={() => setConfirmRevoke(null)} />
                        <SmallButton colors={colors} label="Revoke" danger disabled={busy} onPress={() => void revoke(token)} />
                      </View>
                    </SettingsRow>
                  ) : null}
                </Fragment>
              );
            })}
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="New token">
          <SettingsCard>
            <SettingsInput
              ref={ref("tokenLabel")}
              label="Label"
              hint="Which client uses it, e.g. Hermes"
              placeholder="Hermes"
              onChangeText={field("tokenLabel")}
              disabled={busy}
            />
            <SettingsSelect
              label="Scope"
              value={newScope}
              options={[
                { label: "Read only (list and read agents)", value: "read" },
                { label: "Full (also start and steer agents)", value: "full" },
              ]}
              onValueChange={(scope) => setNewScope(scope === "full" ? "full" : "read")}
              disabled={busy}
            />
            <SettingsInput
              ref={ref("tokenOrigin")}
              label="Origin label"
              hint="Set as origin=… on agents this token starts. Empty: the default below, else the token label."
              placeholder="hermes"
              onChangeText={field("tokenOrigin")}
              disabled={busy}
            />
            <SettingsInput
              ref={ref("tokenFilter")}
              label="Only agents with labels"
              hint="Optional, e.g. origin=hermes: this token's events and resources cover only those agents."
              placeholder="origin=hermes"
              onChangeText={field("tokenFilter")}
              disabled={busy}
            />
            <SettingsAction
              label="Create token"
              actionLabel={busy ? "Creating…" : "Create"}
              disabled={busy}
              onPress={() => void createToken()}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          title="Connect an HTTP client"
          info={
            created
              ? "These snippets contain the new token. Copy them before you hide it."
              : "Replace <token> with a token from above. Hermes needs a restart after editing its config."
          }
        >
          <SettingsCard>
            <SettingsRow label="Hermes · config.yaml" hint="Under mcp_servers in ~/.hermes/config.yaml" />
            <Block>
              <CodeBlock colors={colors} text={hermesSnippet(url, snippetToken)} copyLabel="Copy Hermes config" />
            </Block>
            <SettingsRow
              label="Claude Code · CLI"
              hint="Named paseo-agents because Paseo agents already have a server called paseo."
            />
            <Block>
              <CodeBlock colors={colors} text={claudeCodeSnippet(url, snippetToken)} copyLabel="Copy Claude Code command" />
            </Block>
            <SettingsRow label="Claude Code · .mcp.json" hint="Project .mcp.json" />
            <Block>
              <CodeBlock colors={colors} text={claudeJsonSnippet(url, snippetToken)} copyLabel="Copy .mcp.json" />
            </Block>
            <SettingsRow label="Any MCP client" hint="Streamable HTTP with this header" />
            <Block>
              <CodeBlock colors={colors} text={`URL: ${url}\nAuthorization: Bearer ${snippetToken}`} copyLabel="Copy URL and header" />
            </Block>
          </SettingsCard>
        </SettingsSection>

        <EventsSection rpc={rpc} colors={colors} values={values} saving={state.saving} update={update} />

        <SettingsSection
          title="Agents"
          info="What clients with a full token may do. Agents only start inside an allowed root; permission requests are never answered automatically."
        >
          <SettingsCard>
            <SettingsSwitch
              label="Read-only"
              hint="Only the list/read tools, for every token. Open sessions reconnect."
              value={values.readOnly}
              onValueChange={(readOnly) => void update((next) => void (next.readOnly = readOnly))}
              disabled={state.saving}
            />
            {values.allowedRoots.length === 0 ? (
              <SettingsRow label="No allowed roots" error="Add at least one folder, or no agent can be started." />
            ) : null}
            {values.allowedRoots.map((root) => (
              <SettingsRow key={root} label={root} hint="Allowed root">
                <SmallButton
                  colors={colors}
                  label="Remove"
                  danger
                  disabled={state.saving}
                  onPress={() => void update((next) => void (next.allowedRoots = next.allowedRoots.filter((r) => r !== root)))}
                />
              </SettingsRow>
            ))}
            <SettingsInput
              ref={ref("root")}
              label="Add allowed root"
              hint="A folder; agents may start in it and below. ~ works."
              placeholder="~/Repositories"
              onChangeText={field("root")}
            />
            <SettingsAction label="" actionLabel="Add root" disabled={state.saving} onPress={() => void addRoot()} />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Defaults for new agents">
          <SettingsCard>
            <SettingsInput
              ref={ref("defaultProvider")}
              label="Provider"
              hint="provider/model; paseo_list_models shows the options"
              initialValue={values.defaultProvider ?? ""}
              placeholder="claude/claude-sonnet-5-5"
              onChangeText={field("defaultProvider")}
            />
            <SettingsInput
              ref={ref("defaultThinking")}
              label="Thinking"
              initialValue={values.defaultThinking ?? ""}
              placeholder="medium"
              onChangeText={field("defaultThinking")}
            />
            <SettingsInput
              ref={ref("defaultMode")}
              label="Permission mode"
              hint="auto, default, acceptEdits or plan"
              initialValue={values.defaultMode ?? ""}
              placeholder="auto"
              onChangeText={field("defaultMode")}
            />
            <SettingsInput
              ref={ref("originLabel")}
              label="Origin label"
              hint="origin=… on agents from tokens without their own. Empty: the token label."
              initialValue={values.originLabel ?? ""}
              placeholder="token label"
              onChangeText={field("originLabel")}
            />
            <SettingsInput
              ref={ref("accountEnvVar")}
              label="Account env var"
              hint="Set to the account's config dir on new agents. Use PASEO_CLAUDE_ACCOUNT with paseo-multi-account."
              initialValue={values.accountEnvVar}
              placeholder="CLAUDE_CONFIG_DIR"
              onChangeText={field("accountEnvVar")}
            />
            <SettingsAction label="" actionLabel="Save" disabled={state.saving} onPress={() => void saveDefaults()} />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          title="Claude accounts"
          info="Named Claude logins a client can pick with paseo_create_agent's account."
        >
          <SettingsCard>
            {Object.entries(values.accounts).map(([name, account]) => (
              <SettingsRow key={name} label={name} hint={[account.configDir, account.note].filter(Boolean).join(" · ")}>
                <SmallButton
                  colors={colors}
                  label="Remove"
                  danger
                  disabled={state.saving}
                  onPress={() =>
                    void update((next) => {
                      delete next.accounts[name];
                      if (next.defaultAccount === name) delete next.defaultAccount;
                    })
                  }
                />
              </SettingsRow>
            ))}
            <SettingsSelect
              label="Default account"
              value={values.defaultAccount ?? ""}
              options={[
                { label: "None", value: "" },
                ...Object.keys(values.accounts).map((name) => ({ label: name, value: name })),
              ]}
              onValueChange={(name) =>
                void update((next) => {
                  if (name) next.defaultAccount = name;
                  else delete next.defaultAccount;
                })
              }
              disabled={state.saving}
            />
            <SettingsInput ref={ref("accountName")} label="Name" placeholder="work" onChangeText={field("accountName")} />
            <SettingsInput
              ref={ref("accountDir")}
              label="Config directory"
              placeholder="~/.claude-work"
              onChangeText={field("accountDir")}
            />
            <SettingsInput ref={ref("accountNote")} label="Note" placeholder="optional" onChangeText={field("accountNote")} />
            <SettingsAction label="" actionLabel="Add account" disabled={state.saving} onPress={() => void addAccount()} />
          </SettingsCard>
        </SettingsSection>

        <StdioSection rpc={rpc} colors={colors} />
      </>
    );
  }

  return { McpSettingsScreen };
}
