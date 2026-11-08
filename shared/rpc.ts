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
