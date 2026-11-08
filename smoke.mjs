// Minimal MCP stdio client: starts the server the way an MCP client would and calls the tools named
// on the command line, e.g. `node smoke.mjs paseo_list_agents 'paseo_get_agent={"agent_id":"ab12"}'`.
// SMOKE_COMMAND overrides the binary (default: node dist/index.js in this checkout).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const command = process.env.SMOKE_COMMAND ?? "node";
const args = process.env.SMOKE_COMMAND ? [] : [new URL("./dist/index.js", import.meta.url).pathname];
// Like Hermes: only PATH and HOME, plus the config path.
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
if (process.env.PASEO_MCP_CONFIG) env.PASEO_MCP_CONFIG = process.env.PASEO_MCP_CONFIG;
if (process.env.PASEO_HOME) env.PASEO_HOME = process.env.PASEO_HOME;
const limit = Number(process.env.SMOKE_MAX_CHARS ?? 1200);

const transport = new StdioClientTransport({ command, args, env });
const client = new Client({ name: "paseo-mcp-smoke", version: "0.0.1" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`TOOLS (${tools.length}): ${tools.join(", ")}`);
let failed = false;
for (const spec of process.argv.slice(2)) {
  const [name, json] = spec.split(/=(.*)/s, 2);
  const result = await client.callTool({ name, arguments: json ? JSON.parse(json) : {} });
  failed ||= Boolean(result.isError);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  console.log(`\n### ${name}${result.isError ? " (ERROR)" : ""}\n${text.length > limit ? `${text.slice(0, limit)}\n… (${text.length} chars)` : text}`);
}
await client.close();
process.exit(failed ? 1 : 0);
