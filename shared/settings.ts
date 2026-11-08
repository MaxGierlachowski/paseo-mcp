// The plugin's settings document, stored by the Paseo host and edited on the settings screen.
// The daemon side reads it with registerSettings and applies every change live.
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_PORT = 6790;
export const DEFAULT_BIND = "127.0.0.1";

export const TokenRecordSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(60),
  scope: z.enum(["read", "full"]),
  /** Hex SHA-256 of the token; the token itself is never stored. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  /** `origin` label on agents this token creates. Empty: the global originLabel, else the token label. */
  origin: z.string().trim().max(60).optional(),
  /** This token only sees events and resources of agents with all these labels. */
  labelFilter: z.record(z.string(), z.string()).optional(),
});

export type StoredToken = z.infer<typeof TokenRecordSchema>;

export const EVENT_TYPE_VALUES = [
  "agent.created",
  "agent.turn_started",
  "agent.turn_ended",
  "agent.permission_requested",
  "agent.permission_resolved",
  "agent.archived",
  "agent.closed",
] as const;

export const WebhookSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(60),
  url: z.string().url(),
  enabled: z.boolean().default(true),
  /** Empty: all types. */
  types: z.array(z.enum(EVENT_TYPE_VALUES)).default([]),
  labels: z.record(z.string(), z.string()).default({}),
  onlyNeedsAttention: z.boolean().default(false),
  /** >0: bundle events arriving within this many milliseconds into one delivery. */
  batchMs: z.number().int().min(0).max(60_000).default(0),
  /** Last four characters of the secret, to tell secrets apart. The secret stays on the daemon. */
  secretHint: z.string().max(8).optional(),
  createdAt: z.string(),
});

export type StoredWebhook = z.infer<typeof WebhookSchema>;

const AccountSchema = z.object({
  configDir: z.string().min(1),
  note: z.string().optional(),
});

export const McpSettingsSchema = z.object({
  http: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1).max(65_535).default(DEFAULT_PORT),
      bind: z.string().trim().min(1).default(DEFAULT_BIND),
    })
    .default({ enabled: false, port: DEFAULT_PORT, bind: DEFAULT_BIND }),
  tokens: z.array(TokenRecordSchema).default([]),
  allowedRoots: z.array(z.string().min(1)).default([]),
  accounts: z.record(z.string(), AccountSchema).default({}),
  defaultAccount: z.string().optional(),
  accountEnvVar: z.string().min(1).default("CLAUDE_CONFIG_DIR"),
  defaultProvider: z.string().optional(),
  defaultThinking: z.string().optional(),
  defaultMode: z.string().optional(),
  /** Overrides the per-token default (the token label) for every token without its own origin. */
  originLabel: z.string().optional(),
  readOnly: z.boolean().default(false),
  events: z
    .object({
      /** >0: turn_ended events carry this many characters of the last agent message (untrusted). */
      previewChars: z.number().int().min(0).max(2000).default(0),
    })
    .default({ previewChars: 0 }),
  webhooks: z.array(WebhookSchema).default([]),
});

export type McpSettings = z.infer<typeof McpSettingsSchema>;

export const mcpSettings = defineSettings({
  id: "mcp",
  scope: "host",
  version: 1,
  schema: McpSettingsSchema,
});

/** The `origin` label for agents created with this token. */
export function originFor(token: Pick<StoredToken, "label" | "origin">, settings: Pick<McpSettings, "originLabel">): string {
  return token.origin?.trim() || settings.originLabel?.trim() || token.label;
}
