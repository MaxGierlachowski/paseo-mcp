// Managed settings: a JSON file an installer or config tool writes, read by the plugin next to the
// settings the screen edits. It is how a headless box (no Paseo app) turns the HTTP server on,
// creates tokens and webhooks without a UI. The plugin watches the file and applies changes live.
//
// Values from the file win over the screen's; tokens and webhooks from both are used side by side.
// Entries from the file are not shown or editable on the screen. Webhook secrets and header values
// stay in the file (mode 600, like the plugin's own state file), never in the settings document.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hashToken } from "./auth.js";
import { expandHome, paseoHome } from "./config.js";
import { checkCustomHeaders, checkSecret, checkWebhookUrl, SIGNATURE_SCHEMES } from "./webhooks.js";
import { EVENT_TYPES } from "./events.js";

/** File path override; default `$PASEO_HOME/paseo-mcp.managed.json`. */
export const MANAGED_ENV = "PASEO_MCP_MANAGED";
/** Ids of entries from the file carry this prefix, so they never collide with the screen's. */
export const MANAGED_ID_PREFIX = "managed:";

export function managedPath(): string {
  const fromEnv = process.env[MANAGED_ENV]?.trim();
  return fromEnv ? expandHome(fromEnv) : join(paseoHome(), "paseo-mcp.managed.json");
}

const Id = z.string().regex(/^[A-Za-z0-9._-]{1,60}$/, "ids use letters, digits, '.', '_' and '-' (max. 60)");
const Labels = z.record(z.string(), z.string());

export const ManagedTokenSchema = z
  .object({
    /** Stable id (default: the label). Sessions and "last used" are tracked per id. */
    id: Id.optional(),
    label: z.string().trim().min(1).max(60),
    scope: z.enum(["read", "full"]),
    /** Hex SHA-256 of the token (what `paseo-mcp-admin token create` writes) … */
    hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** … or the token itself, for tools that keep it in their own secret store anyway. */
    token: z.string().min(24).optional(),
    origin: z.string().trim().max(60).optional(),
    labelFilter: Labels.optional(),
    createdAt: z.string().optional(),
  })
  .strict()
  .refine((t) => (t.hash === undefined) !== (t.token === undefined), "a token needs exactly one of hash or token");

export const ManagedWebhookSchema = z
  .object({
    id: Id.optional(),
    label: z.string().trim().min(1).max(60),
    url: z.string().url(),
    enabled: z.boolean().default(true),
    types: z.array(z.enum(EVENT_TYPES)).default([]),
    labels: Labels.default({}),
    onlyNeedsAttention: z.boolean().default(false),
    batchMs: z.number().int().min(0).max(60_000).default(0),
    signature: z.enum(SIGNATURE_SCHEMES).default("paseo"),
    secret: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const AccountSchema = z.object({ configDir: z.string().min(1), note: z.string().optional() }).strict();

export const ManagedFileSchema = z
  .object({
    http: z
      .object({
        enabled: z.boolean().optional(),
        port: z.number().int().min(1).max(65_535).optional(),
        bind: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    tokens: z.array(ManagedTokenSchema).default([]),
    webhooks: z.array(ManagedWebhookSchema).default([]),
    allowedRoots: z.array(z.string().min(1)).optional(),
    accounts: z.record(z.string(), AccountSchema).optional(),
    defaultAccount: z.string().optional(),
    accountEnvVar: z.string().min(1).optional(),
    defaultProvider: z.string().optional(),
    defaultThinking: z.string().optional(),
    defaultMode: z.string().optional(),
    originLabel: z.string().optional(),
    metaLabels: Labels.optional(),
    readOnly: z.boolean().optional(),
    events: z.object({ previewChars: z.number().int().min(0).max(2000).optional() }).strict().optional(),
  })
  .strict();

export type ManagedFile = z.infer<typeof ManagedFileSchema>;

/** The parts of the plugin settings a managed file can set (structurally the same as McpSettings). */
export interface MergeableSettings {
  http: { enabled: boolean; port: number; bind: string };
  tokens: {
    id: string;
    label: string;
    scope: "read" | "full";
    hash: string;
    createdAt: string;
    origin?: string;
    labelFilter?: Record<string, string>;
  }[];
  webhooks: {
    id: string;
    label: string;
    url: string;
    enabled: boolean;
    types: (typeof EVENT_TYPES)[number][];
    labels: Record<string, string>;
    onlyNeedsAttention: boolean;
    batchMs: number;
    signature: (typeof SIGNATURE_SCHEMES)[number];
    secretHint?: string;
    headerNames: string[];
    createdAt: string;
  }[];
  allowedRoots: string[];
  accounts: Record<string, { configDir: string; note?: string }>;
  defaultAccount?: string;
  accountEnvVar: string;
  defaultProvider?: string;
  defaultThinking?: string;
  defaultMode?: string;
  originLabel?: string;
  metaLabels: Record<string, string>;
  readOnly: boolean;
  events: { previewChars: number };
}

/** A checked managed file, ready to merge: hashes computed, secrets and headers split off. */
export interface ManagedConfig {
  file: ManagedFile;
  tokens: MergeableSettings["tokens"];
  webhooks: MergeableSettings["webhooks"];
  secrets: Map<string, string>;
  headers: Map<string, Record<string, string>>;
}

const EPOCH = new Date(0).toISOString();

/** Validates a parsed managed file. Throws with a readable message on the first problem. */
export function resolveManaged(raw: unknown): ManagedConfig {
  const parsed = ManagedFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  }
  const file = parsed.data;
  if (file.defaultAccount && file.accounts && !file.accounts[file.defaultAccount]) {
    throw new Error(`defaultAccount "${file.defaultAccount}" is not in accounts`);
  }
  const seen = { token: new Set<string>(), webhook: new Set<string>() };
  const unique = (kind: keyof typeof seen, id: string) => {
    if (seen[kind].has(id)) throw new Error(`two ${kind}s with the id "${id.slice(MANAGED_ID_PREFIX.length)}"`);
    seen[kind].add(id);
    return id;
  };
  const tokens = file.tokens.map((t) => ({
    id: unique("token", MANAGED_ID_PREFIX + (t.id ?? t.label)),
    label: t.label,
    scope: t.scope,
    hash: t.hash ?? hashToken(t.token!),
    createdAt: t.createdAt ?? EPOCH,
    ...(t.origin ? { origin: t.origin } : {}),
    ...(t.labelFilter && Object.keys(t.labelFilter).length ? { labelFilter: t.labelFilter } : {}),
  }));
  const secrets = new Map<string, string>();
  const headers = new Map<string, Record<string, string>>();
  const webhooks = file.webhooks.map((w) => {
    const id = unique("webhook", MANAGED_ID_PREFIX + (w.id ?? w.label));
    const problem =
      checkWebhookUrl(w.url) ?? checkSecret(w.secret, w.signature) ?? checkCustomHeaders(w.headers);
    if (problem) throw new Error(`webhook "${w.label}": ${problem}`);
    secrets.set(id, w.secret);
    if (Object.keys(w.headers).length) headers.set(id, { ...w.headers });
    return {
      id,
      label: w.label,
      url: w.url,
      enabled: w.enabled,
      types: w.types,
      labels: w.labels,
      onlyNeedsAttention: w.onlyNeedsAttention,
      batchMs: w.batchMs,
      signature: w.signature,
      secretHint: w.secret.slice(-4),
      headerNames: Object.keys(w.headers),
      createdAt: EPOCH,
    };
  });
  return { file, tokens, webhooks, secrets, headers };
}

export type ManagedLoad =
  | { status: "missing" }
  | { status: "ready"; config: ManagedConfig }
  | { status: "invalid"; error: string };

/** Reads and checks the managed file. A missing file is not an error. */
export function loadManaged(path = managedPath()): ManagedLoad {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid", error: `cannot read ${path}: ${(e as Error).message}` };
  }
  if (!text.trim()) return { status: "missing" };
  try {
    return { status: "ready", config: resolveManaged(JSON.parse(text)) };
  } catch (e) {
    return { status: "invalid", error: `${path}: ${(e as Error).message}` };
  }
}

/** The settings the plugin runs with: the screen's, overridden and extended by the managed file. */
export function mergeManaged<S extends MergeableSettings>(ui: S, managed: ManagedConfig | null): S {
  if (!managed) return ui;
  const f = managed.file;
  const pick = <K extends keyof S>(key: K, value: S[K] | undefined): Partial<S> =>
    (value === undefined ? {} : { [key]: value }) as Partial<S>;
  return {
    ...ui,
    http: { ...ui.http, ...stripUndefined(f.http ?? {}) },
    tokens: [...ui.tokens, ...managed.tokens],
    webhooks: [...ui.webhooks, ...managed.webhooks],
    events: { ...ui.events, ...stripUndefined(f.events ?? {}) },
    ...pick("allowedRoots", f.allowedRoots as S["allowedRoots"] | undefined),
    ...pick("accounts", f.accounts as S["accounts"] | undefined),
    ...pick("defaultAccount", f.defaultAccount as S["defaultAccount"]),
    ...pick("accountEnvVar", f.accountEnvVar as S["accountEnvVar"] | undefined),
    ...pick("defaultProvider", f.defaultProvider as S["defaultProvider"]),
    ...pick("defaultThinking", f.defaultThinking as S["defaultThinking"]),
    ...pick("defaultMode", f.defaultMode as S["defaultMode"]),
    ...pick("originLabel", f.originLabel as S["originLabel"]),
    ...pick("metaLabels", f.metaLabels as S["metaLabels"] | undefined),
    ...pick("readOnly", f.readOnly as S["readOnly"] | undefined),
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function isManagedId(id: string): boolean {
  return id.startsWith(MANAGED_ID_PREFIX);
}
