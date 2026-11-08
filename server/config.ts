import { readFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

const AccountSchema = z.object({
  /** Claude Code config dir for this account, e.g. ~/.claude-account-a */
  configDir: z.string(),
  /** Optional human description, shown to the agent in paseo_list_accounts. */
  note: z.string().optional(),
});

const ConfigSchema = z.object({
  daemonUrl: z.string().default("ws://127.0.0.1:6767/ws"),
  /** Optional; PASEO_PASSWORD env wins. */
  password: z.string().optional(),
  /** Default provider/model in `provider/model` form, e.g. "claude/sonnet". */
  defaultProvider: z.string().optional(),
  /** Default thinking option for new agents, e.g. "medium". */
  defaultThinking: z.string().optional(),
  /** Default permission mode for new agents, e.g. "auto" (Claude Code auto mode). */
  defaultMode: z.string().optional(),
  /** Agents may only be created with a cwd inside one of these folders. */
  allowedRoots: z.array(z.string()).min(1),
  /** Named Claude accounts. Key = name Hermes uses (e.g. "a", "work", "max"). */
  accounts: z.record(z.string(), AccountSchema).default({}),
  defaultAccount: z.string().optional(),
  /** Env var set on new agents to pick the account. Claude Code reads CLAUDE_CONFIG_DIR. */
  accountEnvVar: z.string().default("CLAUDE_CONFIG_DIR"),
  /** Label written on every agent this server creates, so you can filter them in Paseo. */
  originLabel: z.string().default("hermes"),
  /** true = only list/read tools are exposed. */
  readOnly: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

/** What the tools read: everything but how to reach the daemon. */
export type ToolConfig = Omit<Config, "daemonUrl" | "password">;

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function loadConfig(): Config {
  const path = expandHome(
    process.env.PASEO_MCP_CONFIG ?? "~/.config/paseo-mcp/config.json",
  );
  if (!existsSync(path)) {
    throw new Error(
      `Config not found at ${path}. Copy config.example.json there or set PASEO_MCP_CONFIG.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const cfg = ConfigSchema.parse(raw);
  if (process.env.PASEO_PASSWORD) cfg.password = process.env.PASEO_PASSWORD;
  if (process.env.PASEO_MCP_READONLY === "1") cfg.readOnly = true;
  if (cfg.defaultAccount && !cfg.accounts[cfg.defaultAccount]) {
    throw new Error(`defaultAccount "${cfg.defaultAccount}" is not in accounts`);
  }
  return cfg;
}

/** Resolves cwd and checks it lies inside an allowed root (symlinks resolved). */
export function checkCwd(cfg: Pick<Config, "allowedRoots">, cwd: string): string {
  if (cfg.allowedRoots.length === 0) {
    throw new Error("No allowedRoots configured, so no agent can be started");
  }
  const abs = resolve(expandHome(cwd));
  if (!existsSync(abs)) throw new Error(`cwd does not exist: ${abs}`);
  const real = realpathSync(abs);
  const ok = cfg.allowedRoots.some((root) => {
    const abs = resolve(expandHome(root));
    // A root that does not exist (typo, unmounted drive) allows nothing instead of throwing.
    if (!existsSync(abs)) return false;
    const r = realpathSync(abs);
    return real === r || real.startsWith(r + sep);
  });
  if (!ok) {
    throw new Error(
      `cwd ${real} is outside allowedRoots (${cfg.allowedRoots.join(", ")})`,
    );
  }
  return real;
}
