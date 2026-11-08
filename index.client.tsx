import type { PluginClientContext } from "@getpaseo/plugin/client";
import { makeMcpSettings } from "./client/McpSettings.js";

// A function declaration, not `const contribute = …; export default contribute`: the host's
// bundle interop reads the default export eagerly, before a const would be assigned.
export default function contribute(client: PluginClientContext) {
  const { McpSettingsScreen } = makeMcpSettings(client.rpc);
  const cleanups = [
    client.addSettingsScreen({
      id: "mcp",
      title: "MCP server",
      icon: "Plug",
      Component: McpSettingsScreen,
    }),
    client.addCommandCenterItem({
      id: "open-mcp",
      title: "MCP server: tokens and client configs for Hermes or Claude Code",
      icon: "Plug",
      keywords: ["mcp", "hermes", "token", "http", "claude code", "connect", "config", "orchestrator", "copy", "stdio"],
      context: "global",
      onSelect: (context) => context.openSettings("mcp"),
    }),
  ];
  return () => {
    for (const cleanup of cleanups.reverse()) void cleanup();
  };
}
