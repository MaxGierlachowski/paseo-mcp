/**
 * Events from the daemon's agent push updates, in both modes. It subscribes to the agent list once,
 * learns the current state without publishing, then turns every changed snapshot into events by
 * comparing it with the hub's state. After a lost connection it lists again; the comparison reports
 * what changed in between, so nothing is silently skipped.
 */
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { isLimitError, type AgentState, type EventHub, type EventInput, type PermissionInfo } from "./events.js";

const RESYNC_CHECK_MS = 5_000;

function permissions(a: PaseoAgent): PermissionInfo[] {
  return (a.pendingPermissions ?? []).map((p) => ({
    requestId: p.id,
    name: p.name ?? null,
    title: p.title ?? null,
    kind: p.kind ?? null,
  }));
}

function base(a: PaseoAgent) {
  return {
    agentId: a.id,
    title: a.title ?? null,
    status: a.status,
    labels: a.labels ?? {},
    requiresAttention: a.requiresAttention ?? false,
    attentionReason: a.attentionReason ?? null,
  };
}

/** The state an agent snapshot implies. */
export function stateOf(a: PaseoAgent): Partial<AgentState> & { agentId: string } {
  return {
    ...base(a),
    inTurn: a.status === "running",
    pendingPermissions: permissions(a),
    // Only ever set here; a snapshot without them does not undo a reported archive/close (the hub
    // clears both when a new turn starts).
    archived: a.archivedAt ? true : undefined,
    closed: a.status === "closed" ? true : undefined,
  };
}

/** Events that lead from the hub's state of an agent to this snapshot. `known`: the agent was seen before. */
/** A snapshot taken before the last hook report on the agent says nothing new. */
export function isStale(prev: AgentState | undefined, a: PaseoAgent): boolean {
  if (!prev?.lastHookAt || !a.updatedAt) return false;
  return Date.parse(a.updatedAt) < Date.parse(prev.lastHookAt);
}

export function diff(prev: AgentState | undefined, a: PaseoAgent): EventInput[] {
  if (isStale(prev, a)) return [];
  const b = { ...base(a), source: "client" as const };
  const out: EventInput[] = [];
  const running = a.status === "running";
  if (!prev) out.push({ ...b, type: "agent.created" });
  if (running && !prev?.inTurn) out.push({ ...b, type: "agent.turn_started", requiresAttention: false, attentionReason: null });
  const nowPending = permissions(a);
  const before = prev?.pendingPermissions ?? [];
  for (const p of nowPending) {
    if (!before.some((q) => q.requestId === p.requestId)) out.push({ ...b, type: "agent.permission_requested", permission: p });
  }
  for (const p of before) {
    if (!nowPending.some((q) => q.requestId === p.requestId)) out.push({ ...b, type: "agent.permission_resolved", permission: p, resolution: null });
  }
  if (prev?.inTurn && (a.status === "idle" || a.status === "error" || a.status === "closed")) {
    const error = a.status === "error" ? (a.lastError ?? null) : null;
    out.push({
      ...b,
      type: "agent.turn_ended",
      outcome: a.status === "error" ? (isLimitError(error) ? "limit" : "error") : "finished",
      error,
    });
  }
  if (a.archivedAt && !prev?.archived) out.push({ ...b, type: "agent.archived" });
  if (a.status === "closed" && !prev?.closed) out.push({ ...b, type: "agent.closed" });
  return out;
}

/** The last assistant message of an agent, for the opt-in preview on turn_ended. */
export async function fetchPreview(api: PaseoApi, agentId: string): Promise<string | null> {
  const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 10, projection: "projected" });
  for (let i = page.entries.length - 1; i >= 0; i--) {
    const item = page.entries[i].item;
    if (item.type === "assistant_message" && item.text.trim()) return item.text;
  }
  return null;
}

export interface ClientSourceOptions {
  hub: EventHub;
  paseo(): Promise<PaseoApi>;
  /** Called after a turn_ended to fetch a preview of the last agent message (opt-in). */
  preview?(api: PaseoApi, agentId: string): Promise<string | null>;
  log?(message: string): void;
}

export class ClientEventSource {
  private api: PaseoApi | null = null;
  private unsubscribe: (() => void) | null = null;
  private release: (() => Promise<void>) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  private stopped = false;
  private connected = false;

  constructor(private readonly opts: ClientSourceOptions) {}

  start(): void {
    void this.sync();
    this.timer = setInterval(() => void this.check(), RESYNC_CHECK_MS);
    this.timer.unref?.();
  }

  /** Lists again when the connection was lost or never made. */
  private async check(): Promise<void> {
    const state = (this.api as { getConnectionState?(): { status: string } } | null)?.getConnectionState?.();
    if (!this.connected || (state && state.status !== "connected")) {
      this.connected = false;
      await this.sync();
    }
  }

  private sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const api = await this.opts.paseo();
        if (this.stopped) return;
        if (api !== this.api) {
          this.unsubscribe?.();
          this.api = api;
          this.unsubscribe = api.agents.subscribe((update) => this.onUpdate(update));
        }
        await this.release?.().catch(() => {});
        const first = this.opts.hub.allStates().length === 0;
        const result = await api.agents.list({ subscribe: {}, filter: { includeArchived: false }, page: { limit: 200 } });
        this.release = () => result.subscription.release();
        for (const { agent } of result.entries) {
          // The first list only teaches the state; later ones (after a reconnect) report changes.
          if (first) this.opts.hub.seed(stateOf(agent));
          else this.apply(agent);
        }
        this.connected = true;
      } catch (e) {
        this.opts.log?.(`event source: ${e instanceof Error ? e.message : String(e)}; retrying`);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private queue: Promise<void> = Promise.resolve();

  private onUpdate(update: { kind: string; agent?: PaseoAgent; agentId?: string }): void {
    if (update.kind === "upsert" && update.agent) this.apply(update.agent);
    else if (update.kind === "remove" && update.agentId) {
      const agentId = update.agentId;
      // Removes also come for internal helper agents never listed; only agents we know matter.
      if (!this.opts.hub.state(agentId)) return;
      this.enqueue(async () => {
        // Left the active list: archived, or gone for good.
        const agent = await this.lookup(agentId);
        if (!agent) this.opts.hub.publish({ type: "agent.closed", agentId, source: "client" });
        else if (agent.archivedAt) this.opts.hub.publish({ ...base(agent), type: "agent.archived", source: "client" });
      });
    }
  }

  private async lookup(agentId: string): Promise<PaseoAgent | null> {
    try {
      const handle = this.api!.agents.ref(agentId);
      return (await handle.refresh())?.agent ?? handle.current() ?? null;
    } catch {
      return null;
    }
  }

  /** Updates are handled one after another, so a slow preview fetch cannot reorder events. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work).catch((e) => this.opts.log?.(`event source: ${e instanceof Error ? e.message : String(e)}`));
    return this.queue;
  }

  apply(agent: PaseoAgent): Promise<void> {
    return this.enqueue(async () => {
      const hub = this.opts.hub;
      for (const input of diff(hub.state(agent.id), agent)) {
        if (input.type === "agent.turn_ended" && hub.previewChars > 0 && this.api && this.opts.preview) {
          input.preview = (await this.opts.preview(this.api, agent.id).catch(() => null)) ?? undefined;
        }
        hub.publish(input);
      }
      if (!isStale(hub.state(agent.id), agent)) hub.seed(stateOf(agent));
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    void this.release?.().catch(() => {});
  }
}
