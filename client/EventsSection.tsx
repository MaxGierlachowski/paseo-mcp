// Events and webhooks on the settings screen. Webhook secrets live on the daemon: the screen sees a
// secret once, right after creating or rotating it, and otherwise only its last four characters.
import { Fragment, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  useToast,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import {
  createWebhookRpc,
  resumeWebhookRpc,
  rotateWebhookSecretRpc,
  testWebhookRpc,
  webhookStatusRpc,
  type DeliveryView,
  type WebhookStatusView,
} from "../shared/rpc.js";
import { EVENT_TYPE_VALUES, type McpSettings, type StoredWebhook } from "../shared/settings.js";
import { ago, parseLabels, plural } from "./format.js";
import { Block, CodeBlock, SmallButton, type Colors } from "./parts.js";

type Rpc = PluginCommandCapabilities["rpc"];
type EventType = (typeof EVENT_TYPE_VALUES)[number];

const POLL_MS = 5_000;

const PRESETS: Record<string, { label: string; types: EventType[]; onlyNeedsAttention: boolean }> = {
  attention: {
    label: "Needs attention (turn ended, permission requested)",
    types: ["agent.turn_ended", "agent.permission_requested"],
    onlyNeedsAttention: true,
  },
  turns: { label: "Turns (started, ended)", types: ["agent.turn_started", "agent.turn_ended"], onlyNeedsAttention: false },
  all: { label: "All events", types: [], onlyNeedsAttention: false },
};

function filterText(w: StoredWebhook): string {
  const parts = [w.types.length ? w.types.map((t) => t.replace("agent.", "")).join(", ") : "all events"];
  if (w.onlyNeedsAttention) parts.push("needs attention");
  const labels = Object.entries(w.labels).map(([k, v]) => `${k}=${v}`);
  if (labels.length) parts.push(labels.join(" "));
  if (w.batchMs) parts.push(`bundled ${w.batchMs} ms`);
  return parts.join(" · ");
}

function deliveryText(d: DeliveryView): string {
  const what = d.test ? "test" : plural(d.events, "event");
  const result =
    d.status === "delivered"
      ? `delivered${d.httpStatus ? ` (${d.httpStatus})` : ""}`
      : d.status === "retrying"
        ? `retrying, attempt ${d.attempts}: ${d.error ?? ""}`
        : `failed after ${plural(d.attempts, "attempt")}: ${d.error ?? ""}`;
  return `${ago(d.at)} · ${what} · ${result}`;
}

export function verifySnippet(): string {
  return [
    'import { createHmac, timingSafeEqual } from "node:crypto";',
    "",
    "// header = request.headers['paseo-mcp-signature'], body = the raw request body (string)",
    "function verify(secret, header, body) {",
    '  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));',
    "  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;",
    '  const mac = createHmac("sha256", secret).update(`${t}.${body}`).digest();',
    '  const given = Buffer.from(v1 ?? "", "hex");',
    "  return given.length === mac.length && timingSafeEqual(given, mac);",
    "}",
  ].join("\n");
}

export function EventsSection({ rpc, colors, values, saving, update }: {
  rpc: Rpc;
  colors: Colors;
  values: McpSettings;
  saving: boolean;
  update(change: (next: McpSettings) => void, success?: string): Promise<boolean>;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<{ webhooks: Record<string, WebhookStatusView>; events: { cursor: string; sources: string[] } } | null>(null);
  const [secret, setSecret] = useState<{ label: string; secret: string } | null>(null);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("attention");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const draft = useRef<Record<string, string>>({});
  const inputs = useRef<Record<string, SettingsInputHandle | null>>({});

  const refresh = () => rpc(webhookStatusRpc, {}).then(setStatus, () => setStatus(null));
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const field = (key: string) => (text: string) => {
    draft.current[key] = text;
  };
  const ref = (key: string) => (h: SettingsInputHandle | null) => {
    inputs.current[key] = h;
  };
  const clear = (key: string) => {
    delete draft.current[key];
    inputs.current[key]?.replaceText("");
  };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));

  async function savePreview() {
    const text = draft.current.preview;
    if (text === undefined) return;
    const n = Number(text.trim() || "0");
    if (!Number.isInteger(n) || n < 0 || n > 2000) return toast.error("Preview length must be 0–2000");
    if (await update((next) => void (next.events.previewChars = n), n ? `Previews of ${n} characters` : "Previews off")) {
      delete draft.current.preview;
    }
  }

  async function create() {
    const label = draft.current.whLabel?.trim();
    const url = draft.current.whUrl?.trim();
    if (!label || !url) return toast.error("A webhook needs a label and a URL");
    const labels = parseLabels(draft.current.whLabels ?? "");
    if (labels === null) return toast.error("Labels: key=value, separated by commas");
    const batchMs = Number((draft.current.whBatch ?? "0").trim() || "0");
    if (!Number.isInteger(batchMs) || batchMs < 0 || batchMs > 60_000) return toast.error("Bundling must be 0–60000 ms");
    const p = PRESETS[preset];
    setBusy("create");
    try {
      const { secret, record } = await rpc(createWebhookRpc, {
        label,
        url,
        types: p.types,
        labels,
        onlyNeedsAttention: p.onlyNeedsAttention,
        batchMs,
      });
      if (await update((next) => void next.webhooks.push(record))) {
        setSecret({ label, secret });
        for (const k of ["whLabel", "whUrl", "whLabels", "whBatch"]) clear(k);
        void refresh();
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, work: () => Promise<unknown>) {
    setBusy(id);
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  const sources = status?.events.sources.join(" and ") ?? "…";

  return (
    <>
      <SettingsSection
        title="Events"
        info="Agent events (created, turn started/ended, permission requested/resolved, archived, closed) reach clients three ways: paseo_wait_for_events (long-poll with a cursor), subscriptions to the paseo://agents resources, and the webhooks below."
      >
        <SettingsCard>
          <SettingsRow
            label="Collecting events"
            hint={`From ${sources}. Cursor ${status?.events.cursor ?? "…"}. Kept for an hour, up to 1000 events; a client with an older cursor gets the current state instead (gap).`}
          />
          <SettingsInput
            ref={ref("preview")}
            label="Message preview"
            hint="0 = off. Otherwise turn_ended carries this many characters of the agent's last message, marked as untrusted. Message content otherwise never leaves Paseo."
            initialValue={String(values.events.previewChars)}
            placeholder="0"
            onChangeText={field("preview")}
          />
          <SettingsAction label="" actionLabel="Save" disabled={saving} onPress={() => void savePreview()} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Webhooks"
        info="POSTs events to your endpoints, signed with HMAC-SHA256 (header Paseo-Mcp-Signature: t=…,v1=…). Retries with backoff; an endpoint pauses after 5 failed deliveries in a row."
      >
        <SettingsCard>
          {secret ? (
            <>
              <SettingsRow
                label={`Secret for ${secret.label}`}
                hint="Copy it now. It is shown only this once; the daemon keeps it to sign deliveries."
              />
              <Block>
                <CodeBlock colors={colors} text={secret.secret} copyLabel="Copy secret" />
              </Block>
              <SettingsRow label="Verify deliveries" hint="Node.js; the README has more languages." />
              <Block>
                <CodeBlock colors={colors} text={verifySnippet()} copyLabel="Copy verify example" />
              </Block>
              <SettingsAction label="Copied it" actionLabel="Hide secret" onPress={() => setSecret(null)} />
            </>
          ) : null}
          {values.webhooks.length === 0 ? <SettingsRow label="No webhooks yet" hint="Add one below." /> : null}
          {values.webhooks.map((w) => {
            const st = status?.webhooks[w.id];
            const last = st?.deliveries[0];
            const state = !w.enabled
              ? "Disabled"
              : st?.paused
                ? `Paused after ${plural(st.consecutiveFailures, "failed delivery")}${st.dropped ? `, ${st.dropped} events skipped` : ""}`
                : last
                  ? `Last: ${deliveryText(last)}`
                  : "No deliveries yet";
            const hint = [w.url, filterText(w), `secret …${w.secretHint ?? "????"}`, state].join("\n");
            const isBusy = busy === w.id;
            return (
              <Fragment key={w.id}>
                <SettingsRow label={w.label} hint={hint} error={st && !st.hasSecret ? "No secret on the daemon; rotate it" : null}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, maxWidth: 260 }}>
                    <SmallButton colors={colors} label="Test" disabled={isBusy} onPress={() =>
                      void act(w.id, async () => {
                        const d = await rpc(testWebhookRpc, { id: w.id });
                        if (d.status === "delivered") toast.show(`Test delivered (${d.httpStatus})`, { variant: "success" });
                        else toast.error(`Test failed: ${d.error ?? "unknown error"}`);
                      })
                    } />
                    {st?.paused ? (
                      <SmallButton colors={colors} label="Resume" primary disabled={isBusy} onPress={() => void act(w.id, () => rpc(resumeWebhookRpc, { id: w.id }))} />
                    ) : null}
                    <SmallButton
                      colors={colors}
                      label={w.enabled ? "Disable" : "Enable"}
                      disabled={saving}
                      onPress={() => void update((next) => void (next.webhooks.find((x) => x.id === w.id)!.enabled = !w.enabled))}
                    />
                    <SmallButton colors={colors} label={open === w.id ? "Less" : "More"} onPress={() => setOpen(open === w.id ? null : w.id)} />
                  </View>
                </SettingsRow>
                {open === w.id ? (
                  <>
                    {(st?.deliveries ?? []).slice(0, 5).map((d) => (
                      <SettingsRow
                        key={`${d.id}-${d.at}`}
                        label={d.status === "delivered" ? "✓ Delivered" : d.status === "retrying" ? "… Retrying" : "✕ Failed"}
                        hint={deliveryText(d)}
                      />
                    ))}
                    {st?.deliveries.length ? null : <SettingsRow label="No deliveries yet" />}
                    <SettingsRow label="Secret" hint="Rotating stops the old secret at once.">
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <SmallButton colors={colors} label="Rotate" disabled={isBusy} onPress={() =>
                          void act(w.id, async () => {
                            const r = await rpc(rotateWebhookSecretRpc, { id: w.id });
                            await update((next) => void (next.webhooks.find((x) => x.id === w.id)!.secretHint = r.secretHint));
                            setSecret({ label: w.label, secret: r.secret });
                          })
                        } />
                        {confirmDelete === w.id ? (
                          <>
                            <SmallButton colors={colors} label="Cancel" onPress={() => setConfirmDelete(null)} />
                            <SmallButton colors={colors} label="Delete" danger disabled={saving} onPress={() =>
                              void update((next) => void (next.webhooks = next.webhooks.filter((x) => x.id !== w.id)), `Deleted ${w.label}`)
                            } />
                          </>
                        ) : (
                          <SmallButton colors={colors} label="Delete" danger onPress={() => setConfirmDelete(w.id)} />
                        )}
                      </View>
                    </SettingsRow>
                  </>
                ) : null}
              </Fragment>
            );
          })}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="New webhook">
        <SettingsCard>
          <SettingsInput ref={ref("whLabel")} label="Label" placeholder="Hermes" onChangeText={field("whLabel")} />
          <SettingsInput
            ref={ref("whUrl")}
            label="URL"
            hint="https://…, or http:// only to localhost or a private address (10.x, 192.168.x, …)."
            placeholder="https://example.com/paseo"
            onChangeText={field("whUrl")}
          />
          <SettingsSelect
            label="Events"
            value={preset}
            options={Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label }))}
            onValueChange={(v) => setPreset(v in PRESETS ? (v as keyof typeof PRESETS) : "attention")}
          />
          <SettingsInput
            ref={ref("whLabels")}
            label="Only agents with labels"
            hint="Optional, key=value separated by commas"
            placeholder="origin=hermes"
            onChangeText={field("whLabels")}
          />
          <SettingsInput
            ref={ref("whBatch")}
            label="Bundle for (ms)"
            hint="0 sends every event on its own; otherwise events within this window go out together."
            placeholder="0"
            onChangeText={field("whBatch")}
          />
          <SettingsAction
            label="Create webhook"
            actionLabel={busy === "create" ? "Creating…" : "Create"}
            disabled={busy === "create"}
            onPress={() => void create()}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
