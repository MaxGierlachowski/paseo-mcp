// Minimal MCP stdio client: starts dist/index.js and calls the tools given on the command line.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("./dist/index.js", import.meta.url).pathname],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, PASEO_MCP_CONFIG: process.env.PASEO_MCP_CONFIG },
});
const client = new Client({ name: "paseo-mcp-smoke", version: "0.0.1" });
await client.connect(transport);
console.log("TOOLS:", (await client.listTools()).tools.map((t) => t.name).join(", "));
for (const spec of process.argv.slice(2)) {
  const [name, json] = spec.split("=", 2);
  const r = await client.callTool({ name, arguments: json ? JSON.parse(json) : {} });
  console.log(`\n### ${name}${r.isError ? " (ERROR)" : ""}\n${r.content.map((c) => c.text).join("\n")}`);
}
await client.close();
