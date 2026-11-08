/**
 * MCP-native push: the resources paseo://agents and paseo://agents/{id} (status JSON), with
 * resources/subscribe. A session gets notifications/resources/updated for what it subscribed to,
 * and notifications/resources/list_changed when agents come or go, but only once it subscribed to
 * something. Over HTTP they travel on the session's GET SSE stream, over stdio on stdout.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PaseoApi } from "@getpaseo/client";
import { matches, type EventFilter, type EventHub } from "./events.js";
import { summarize } from "./tools.js";

export const AGENTS_URI = "paseo://agents";
const AGENT_PREFIX = "paseo://agents/";

export interface ResourceContext {
  events: EventHub;
  paseo(): Promise<PaseoApi>;
  /** Restricts which agents this session sees (a token's label filter). */
  eventFilter?(): EventFilter | undefined;
}

function json(uri: string, data: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
}

function labelsMatch(labels: Record<string, string> | undefined, filter: EventFilter | undefined): boolean {
  for (const [k, v] of Object.entries(filter?.labels ?? {})) if (labels?.[k] !== v) return false;
  return true;
}

/** Registers the resources and subscriptions on a server before it connects. Returns a cleanup. */
export function registerAgentResources(server: McpServer, ctx: ResourceContext): () => void {
  const subscriptions = new Set<string>();
  const filter = () => ctx.eventFilter?.();

  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });

  server.registerResource(
    "agents",
    AGENTS_URI,
    {
      title: "Paseo agents",
      description:
        "All active agents with status, attention flag and pending permissions, plus events_cursor for paseo_wait_for_events. Subscribe to be notified when any agent changes.",
      mimeType: "application/json",
    },
    async (uri) => {
      const cursor = ctx.events.cursor();
      const api = await ctx.paseo();
      const { entries } = await api.agents.list({
        filter: { includeArchived: false, labels: filter()?.labels },
        sort: [
          { key: "status_priority", direction: "desc" },
          { key: "updated_at", direction: "desc" },
        ],
        page: { limit: 200 },
      });
      return json(uri.href, { events_cursor: cursor, count: entries.length, agents: entries.map((e) => summarize(e.agent)) });
    },
  );

  server.registerResource(
    "agent",
    new ResourceTemplate(`${AGENT_PREFIX}{id}`, {
      list: async () => ({
        resources: ctx.events
          .allStates()
          .filter((s) => !s.archived && !s.closed && labelsMatch(s.labels, filter()))
          .slice(0, 200)
          .map((s) => ({ uri: `${AGENT_PREFIX}${s.agentId}`, name: s.title ?? s.agentId, mimeType: "application/json" })),
      }),
    }),
    {
      title: "Paseo agent",
      description: "One agent's state: status, attention, pending permissions (with requestId), last error, labels. Subscribe to follow it.",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      const agentId = String(id);
      const cursor = ctx.events.cursor();
      const api = await ctx.paseo();
      const handle = api.agents.ref(agentId);
      const r = await handle.refresh();
      const agent = r?.agent ?? handle.current();
      if (!agent || !labelsMatch(agent.labels, filter())) throw new Error(`No agent ${agentId}`);
      return json(uri.href, { events_cursor: cursor, ...summarize(agent) });
    },
  );

  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri !== AGENTS_URI && !uri.startsWith(AGENT_PREFIX)) throw new Error(`Cannot subscribe to ${uri}`);
    subscriptions.add(uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });

  const unsubscribe = ctx.events.subscribe((event) => {
    if (!subscriptions.size) return;
    const f = filter();
    if (f && !matches(event, { labels: f.labels })) return;
    const send = (uri: string) => void server.server.sendResourceUpdated({ uri }).catch(() => {});
    if (subscriptions.has(AGENTS_URI)) send(AGENTS_URI);
    const one = `${AGENT_PREFIX}${event.agentId}`;
    if (subscriptions.has(one)) send(one);
    if (event.type === "agent.created" || event.type === "agent.archived" || event.type === "agent.closed") {
      void server.server.sendResourceListChanged().catch(() => {});
    }
  });

  const previous = server.server.onclose;
  server.server.onclose = () => {
    unsubscribe();
    subscriptions.clear();
    previous?.();
  };
  return unsubscribe;
}
