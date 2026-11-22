#!/usr/bin/env node
/**
 * paseo-mcp-admin: edits the plugin's managed settings file without the Paseo app, for headless
 * installs and config tools. The running plugin picks changes up within a few seconds.
 *
 *   paseo-mcp-admin token create --label hermes-ui --scope full [--id hermes-ui] [--origin hermes]
 *                                [--label-filter origin=hermes] [--out FILE] [--replace]
 *   paseo-mcp-admin token list [--json]
 *   paseo-mcp-admin token revoke <id>
 *   paseo-mcp-admin hash            (token on stdin → hex SHA-256, for the file's "hash" field)
 *   paseo-mcp-admin check           (validates the file; exit 1 if invalid)
 *   paseo-mcp-admin path            (prints the file's path)
 *
 * Global: --file PATH (default $PASEO_MCP_MANAGED, else $PASEO_HOME/paseo-mcp.managed.json).
 * The token is printed once on stdout (or written to --out with mode 600) and stored only as a hash.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { generateToken, hashToken } from "./auth.js";
import { expandHome } from "./config.js";
import { loadManaged, managedPath, resolveManaged } from "./managed.js";

type Json = Record<string, unknown>;

const USAGE = `Usage: paseo-mcp-admin [--file PATH] <command>

Commands:
  token create --label L --scope read|full [--id ID] [--origin O] [--label-filter k=v ...]
               [--out FILE] [--replace]   New token: printed once (or written to FILE), stored as a hash
  token list [--json]                     Tokens in the managed file (no hashes)
  token revoke ID                         Removes a token; its sessions close at once
  hash                                    Reads a token on stdin, prints its hex SHA-256
  check                                   Validates the managed file
  path                                    Prints the managed file's path

The file defaults to $PASEO_MCP_MANAGED, else $PASEO_HOME/paseo-mcp.managed.json.`;

class UsageError extends Error {}

function readFile(path: string): Json {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} is not a JSON object`);
  return raw as Json;
}

function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** Writes the document after checking it the way the plugin will. */
function save(path: string, doc: Json): void {
  resolveManaged(doc);
  writeFileAtomic(path, `${JSON.stringify(doc, null, 2)}\n`);
}

function parseLabels(values: string[] | undefined): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const out: Record<string, string> = {};
  for (const v of values) {
    const i = v.indexOf("=");
    if (i <= 0) throw new UsageError(`--label-filter wants key=value, got "${v}"`);
    out[v.slice(0, i)] = v.slice(i + 1);
  }
  return out;
}

function tokens(doc: Json): Json[] {
  const list = doc.tokens ?? [];
  if (!Array.isArray(list)) throw new Error("tokens is not a list");
  return list as Json[];
}

const tokenId = (t: Json) => String(t.id ?? t.label);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      file: { type: "string" },
      label: { type: "string" },
      scope: { type: "string" },
      id: { type: "string" },
      origin: { type: "string" },
      "label-filter": { type: "string", multiple: true },
      out: { type: "string" },
      replace: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const path = values.file ? expandHome(values.file) : managedPath();
  const [cmd, sub, arg] = positionals;

  if (cmd === "path") {
    console.log(path);
    return 0;
  }
  if (cmd === "hash") {
    const token = await readStdin();
    if (!token) throw new UsageError("no token on stdin");
    console.log(hashToken(token));
    return 0;
  }
  if (cmd === "check") {
    const result = loadManaged(path);
    if (result.status === "invalid") {
      console.error(`invalid: ${result.error}`);
      return 1;
    }
    if (result.status === "missing") console.log(`${path}: no file (nothing managed)`);
    else console.log(`${path}: ok, ${result.config.tokens.length} token(s), ${result.config.webhooks.length} webhook(s)`);
    return 0;
  }
  if (cmd !== "token") throw new UsageError(`unknown command "${cmd}"`);

  const doc = readFile(path);
  const list = tokens(doc);
  if (sub === "list") {
    const rows = list.map((t) => ({ id: tokenId(t), label: t.label, scope: t.scope, origin: t.origin ?? null, labelFilter: t.labelFilter ?? null, createdAt: t.createdAt ?? null }));
    if (values.json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`${r.id}\t${r.scope}\t${r.label}${r.origin ? `\torigin=${r.origin}` : ""}`);
    return 0;
  }
  if (sub === "revoke") {
    if (!arg) throw new UsageError("token revoke needs an id");
    const kept = list.filter((t) => tokenId(t) !== arg);
    if (kept.length === list.length) {
      console.error(`no token with id "${arg}"`);
      return 1;
    }
    save(path, { ...doc, tokens: kept });
    console.error(`revoked ${arg}`);
    return 0;
  }
  if (sub === "create") {
    const label = values.label?.trim();
    const scope = values.scope;
    if (!label) throw new UsageError("token create needs --label");
    if (scope !== "read" && scope !== "full") throw new UsageError("token create needs --scope read or --scope full");
    const id = values.id?.trim() || label;
    const exists = list.some((t) => tokenId(t) === id);
    if (exists && !values.replace) {
      console.error(`a token with id "${id}" exists; pass --replace to rotate it`);
      return 1;
    }
    const token = generateToken();
    const labelFilter = parseLabels(values["label-filter"]);
    const record: Json = {
      ...(values.id ? { id } : {}),
      label,
      scope,
      hash: hashToken(token),
      ...(values.origin?.trim() ? { origin: values.origin.trim() } : {}),
      ...(labelFilter ? { labelFilter } : {}),
      createdAt: new Date().toISOString(),
    };
    // Write the token before the hash goes live, so a failed write leaves nothing half done.
    if (values.out) writeFileAtomic(expandHome(values.out), `${token}\n`);
    save(path, { ...doc, tokens: [...list.filter((t) => tokenId(t) !== id), record] });
    if (values.out) console.error(`token "${id}" (${scope}) written to ${values.out}`);
    else console.log(token);
    return 0;
  }
  throw new UsageError(`unknown token command "${sub ?? ""}"`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`paseo-mcp-admin: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof UsageError) console.error(`\n${USAGE}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  },
);
