// Contracts between the settings screen and the daemon side.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { TokenRecordSchema } from "./settings.js";

export const StatusSchema = z.object({
  enabled: z.boolean(),
  listening: z.boolean(),
  /** The URL clients connect to, when listening. */
  url: z.string().nullable(),
  /** Why the server is not listening although enabled, e.g. a port collision. */
  error: z.string().nullable(),
  /** Open sessions per token id. */
  sessions: z.record(z.string(), z.number()),
  /** Last authenticated request per token id (ISO time). */
  lastUsed: z.record(z.string(), z.string()),
});

export type McpStatus = z.infer<typeof StatusSchema>;

export const statusRpc = defineRpc({
  name: "mcp.status",
  input: z.object({}),
  output: StatusSchema,
});

/**
 * Creates a token on the daemon and returns it with the record to store. The daemon keeps neither:
 * the screen saves the record (hash only) into the settings and shows the token once.
 */
export const createTokenRpc = defineRpc({
  name: "mcp.tokens.create",
  input: z.object({
    label: z.string().trim().min(1).max(60),
    scope: z.enum(["read", "full"]),
    origin: z.string().trim().max(60).optional(),
  }),
  output: z.object({ token: z.string(), record: TokenRecordSchema }),
});

// ---------------------------------------------------------------- stdio clients

export const SnippetSchema = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string(),
  text: z.string(),
});

export type SnippetView = z.infer<typeof SnippetSchema>;

export const StdioStatusSchema = z.object({
  pluginDirectory: z.string().nullable(),
  /** What stdio clients should run: the launcher when it is ours, else bin/paseo-mcp in the checkout. */
  command: z.string().nullable(),
  built: z.boolean(),
  launcher: z.object({
    path: z.string(),
    status: z.enum(["written", "unchanged", "foreign-file", "plugin-not-found"]),
  }),
  config: z.object({
    path: z.string(),
    exists: z.boolean(),
    error: z.string().nullable(),
    allowedRoots: z.array(z.string()),
    accounts: z.array(z.string()),
    readOnly: z.boolean(),
    hasPassword: z.boolean(),
  }),
  auth: z.object({
    /** open: the daemon has no password; local-credential: the server reads Paseo's loopback token. */
    mode: z.enum(["open", "local-credential", "password-in-config", "missing-credential"]),
    /** Masked preview of the loopback token, never the token itself. */
    masked: z.string().nullable(),
  }),
  snippets: z.array(SnippetSchema),
});

export type StdioStatusView = z.infer<typeof StdioStatusSchema>;

export const ProbeSchema = z.object({
  ok: z.boolean(),
  tools: z.number().nullable(),
  agents: z.number().nullable(),
  ms: z.number(),
  error: z.string().nullable(),
});

export type ProbeView = z.infer<typeof ProbeSchema>;

export const stdioStatusRpc = defineRpc({ name: "mcp.stdio.status", input: z.object({}), output: StdioStatusSchema });

/** Starts the stdio server like a client would and calls tools/list and paseo_list_agents. */
export const probeRpc = defineRpc({ name: "mcp.stdio.probe", input: z.object({}), output: ProbeSchema });
