// What the settings screen shows about stdio clients: the command, the config file they read, how
// they sign in to the daemon, ready-made client configs, and a probe that starts the server the way
// a client does. Reads files only; never returns a credential.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expandHome, paseoHome } from "../config.js";
import type { ProbeView, SnippetView, StdioStatusView } from "../../shared/rpc.js";
import { syncLauncher } from "./launcher.js";

const PROBE_TIMEOUT_MS = 20_000;

export function configPath(): string {
  return expandHome(process.env.PASEO_MCP_CONFIG ?? "~/.config/paseo-mcp/config.json");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readConfig(file: string): StdioStatusView["config"] {
  const view: StdioStatusView["config"] = {
    path: file,
    exists: existsSync(file),
    error: null,
    allowedRoots: [],
    accounts: [],
    readOnly: false,
    hasPassword: false,
  };
  if (!view.exists) return view;
  try {
    const raw = readJson(file) as Record<string, unknown>;
    view.allowedRoots = Array.isArray(raw.allowedRoots) ? raw.allowedRoots.map(String) : [];
    view.accounts = raw.accounts && typeof raw.accounts === "object" ? Object.keys(raw.accounts) : [];
    view.readOnly = raw.readOnly === true;
    view.hasPassword = typeof raw.password === "string" && raw.password.length > 0;
    if (view.allowedRoots.length === 0) view.error = "allowedRoots is empty; the server refuses to start";
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
  }
  return view;
}

function readAuth(config: StdioStatusView["config"]): StdioStatusView["auth"] {
  if (config.hasPassword) return { mode: "password-in-config", masked: "••••••••" };
  let daemonHasPassword = false;
  try {
    const daemon = readJson(path.join(paseoHome(), "config.json")) as { daemon?: { auth?: { password?: unknown } } };
    daemonHasPassword = Boolean(daemon.daemon?.auth?.password);
  } catch {
    // No readable daemon config: the default, no password.
  }
  let token: string | null = null;
  try {
    token = readFileSync(path.join(paseoHome(), "local-credential"), "utf8").trim() || null;
  } catch {
    token = null;
  }
  const masked = token ? `${"•".repeat(12)}${token.slice(-4)}` : null;
  if (!daemonHasPassword) return { mode: "open", masked };
  return token ? { mode: "local-credential", masked } : { mode: "missing-credential", masked: null };
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return /^[\w./~:@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function stdioSnippets(command: string, config: string): SnippetView[] {
  const hermes = [
    "mcp_servers:",
    "  paseo:",
    `    command: ${quoteYaml(command)}`,
    "    args: []",
    "    env:",
    `      PASEO_MCP_CONFIG: ${quoteYaml(config)}`,
    "    timeout: 300",
    "    connect_timeout: 30",
  ].join("\n");
  const claudeJson = JSON.stringify(
    { mcpServers: { "paseo-agents": { type: "stdio", command, args: [], env: { PASEO_MCP_CONFIG: config } } } },
    null,
    2,
  );
  return [
    {
      id: "hermes",
      label: "Hermes · config.yaml",
      hint: "Under mcp_servers in ~/.hermes/config.yaml. Hermes passes only PATH and HOME on, so the config path goes under env.",
      text: hermes,
    },
    {
      id: "claude-json",
      label: "Claude Code · .mcp.json",
      hint: "Project .mcp.json. Named paseo-agents because Paseo agents already have a server called paseo.",
      text: claudeJson,
    },
    {
      id: "claude-cli",
      label: "Claude Code · CLI",
      hint: "The same server with claude mcp add (local scope; add --scope user for every project).",
      text: `claude mcp add paseo-agents --env PASEO_MCP_CONFIG=${shellQuote(config)} -- ${shellQuote(command)}`,
    },
    {
      id: "stdio",
      label: "Any MCP client · stdio",
      hint: "Command and environment for any client that starts stdio servers.",
      text: `PASEO_MCP_CONFIG=${shellQuote(config)} ${shellQuote(command)}`,
    },
  ];
}

export async function stdioStatus(): Promise<StdioStatusView> {
  const launcher = await syncLauncher();
  const pluginCommand = launcher.pluginDirectory ? path.join(launcher.pluginDirectory, "bin", "paseo-mcp") : null;
  const ours = launcher.status === "written" || launcher.status === "unchanged";
  const command = ours ? launcher.launcherPath : pluginCommand;
  const config = readConfig(configPath());
  return {
    pluginDirectory: launcher.pluginDirectory,
    command,
    built: launcher.built,
    launcher: { path: launcher.launcherPath, status: launcher.status },
    config,
    auth: readAuth(config),
    snippets: command ? stdioSnippets(command, config.path) : [],
  };
}

/**
 * Starts the stdio server exactly like a client does (PATH + HOME + PASEO_MCP_CONFIG) and speaks
 * just enough JSON-RPC to list the tools and count the agents. Output is never logged.
 */
export function probe(command: string): Promise<ProbeView> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        PASEO_MCP_CONFIG: configPath(),
        ...(process.env.PASEO_HOME ? { PASEO_HOME: process.env.PASEO_HOME } : {}),
      },
    });
    let tools: number | null = null;
    let buffer = "";
    let stderr = "";
    let settled = false;

    const finish = (result: Omit<ProbeView, "ms" | "tools">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({ tools, ...result, ms: Date.now() - started });
    };
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(
      () => finish({ ok: false, agents: null, error: `no answer within ${PROBE_TIMEOUT_MS / 1000}s` }),
      PROBE_TIMEOUT_MS,
    );

    child.on("error", (error) => finish({ ok: false, agents: null, error: error.message }));
    child.on("exit", (code) =>
      finish({ ok: false, agents: null, error: stderr.trim().split("\n").at(-1) || `exited with code ${code}` }),
    );
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: number; result?: any; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.error) {
          finish({ ok: false, agents: null, error: message.error.message ?? "MCP error" });
        } else if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          tools = Array.isArray(message.result?.tools) ? message.result.tools.length : 0;
          send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "paseo_list_agents", arguments: {} } });
        } else if (message.id === 3) {
          const text: string = message.result?.content?.[0]?.text ?? "";
          if (message.result?.isError) {
            finish({ ok: false, agents: null, error: text.slice(0, 300) || "paseo_list_agents failed" });
            return;
          }
          let agents: number | null = null;
          try {
            agents = Number(JSON.parse(text).count);
          } catch {
            agents = null;
          }
          finish({ ok: true, agents, error: null });
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "paseo-plugin-probe", version: "1" } },
    });
  });
}
