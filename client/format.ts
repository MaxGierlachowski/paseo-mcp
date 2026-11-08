// Text for the settings screen: connection snippets and relative times.

export const TOKEN_PLACEHOLDER = "<token>";

export function hermesSnippet(url: string, token: string, name = "paseo"): string {
  return [
    "mcp_servers:",
    `  ${name}:`,
    `    url: "${url}"`,
    "    headers:",
    `      Authorization: "Bearer ${token}"`,
    "    timeout: 300          # paseo_wait_for_agent blocks up to timeout_sec",
  ].join("\n");
}

export function claudeJsonSnippet(url: string, token: string, name = "paseo-agents"): string {
  return JSON.stringify(
    { mcpServers: { [name]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

/** Named paseo-agents by default: Paseo agents already have an MCP server called paseo. */
export function claudeCodeSnippet(url: string, token: string, name = "paseo-agents"): string {
  return `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${token}"`;
}

/** The URL a client on this machine uses, from the bind address and port. */
export function connectUrl(bind: string, port: number): string {
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind.includes(":") ? `[${bind}]` : bind;
  return `http://${host}:${port}/mcp`;
}

export function isLoopback(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost" || bind.startsWith("127.");
}

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function day(iso: string): string {
  return iso.slice(0, 10);
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "a=1, b=2" → {a:"1", b:"2"}; "" → {}; null when malformed. */
export function parseLabels(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i <= 0 || i === part.length - 1) return null;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
