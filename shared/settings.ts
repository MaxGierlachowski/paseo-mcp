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
});

export type StoredToken = z.infer<typeof TokenRecordSchema>;

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
