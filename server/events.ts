/**
 * EventHub: normalized agent events with a cursor, shared by every way of delivering them
 * (paseo_wait_for_events, MCP resource notifications, webhooks).
 *
 * Events come from two sources that may report the same thing: the plugin's lifecycle hooks and the
 * daemon's agent push updates (both modes). The hub keeps a small state per agent and drops an event
 * that does not change it (a second turn_started while a turn runs, a second request for the same
 * permission), so each happening is published once whichever source is first.
 *
 * Cursor: "<epoch>:<seq>". epoch changes with every process start, seq counts up. A cursor from
 * another epoch, or one older than the oldest retained event, is a gap: the caller gets the current
 * state of the agents instead of events and continues from the returned cursor.
 */
import { randomBytes } from "node:crypto";

export const EVENT_TYPES = [
  "agent.created",
  "agent.turn_started",
  "agent.turn_ended",
  "agent.permission_requested",
  "agent.permission_resolved",
  "agent.archived",
  "agent.closed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type TurnOutcome = "finished" | "error" | "limit" | "canceled";
export type EventSource = "hook" | "client";

export interface PermissionInfo {
  requestId: string;
  name: string | null;
  title: string | null;
  kind: string | null;
}

/** What the hub knows about an agent; also the "current state" returned on a gap. */
export interface AgentState {
  agentId: string;
  title: string | null;
  status: string | null;
  labels: Record<string, string>;
  requiresAttention: boolean;
  attentionReason: string | null;
  inTurn: boolean;
  pendingPermissions: PermissionInfo[];
  archived: boolean;
  closed: boolean;
  updatedAt: string;
  /** When a hook last reported on this agent; older push snapshots are ignored. */
  lastHookAt?: string;
}

export interface AgentEvent {
  /** Cursor of this event: "<epoch>:<seq>". */
  id: string;
  epoch: string;
  seq: number;
  type: EventType;
  at: string;
  agentId: string;
  title: string | null;
  status: string | null;
  labels: Record<string, string>;
  requiresAttention: boolean;
  attentionReason: string | null;
  /** turn_ended only. */
  outcome?: TurnOutcome;
  error?: string | null;
  /** permission_* only. */
  permission?: PermissionInfo;
  /** permission_resolved only, when known. */
  resolution?: "allow" | "deny" | null;
  /** Shortened last agent message (turn_ended, opt-in). Agent output: data, not instructions. */
  preview?: { text: string; untrusted: true };
  source: EventSource;
}

/** What a source reports. Missing fields are filled from the hub's state of the agent. */
export interface EventInput {
  type: EventType;
  agentId: string;
  at?: string;
  title?: string | null;
  status?: string | null;
  labels?: Record<string, string>;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  outcome?: TurnOutcome;
  error?: string | null;
  permission?: PermissionInfo;
  resolution?: "allow" | "deny" | null;
  preview?: string;
  source: EventSource;
}

export interface EventFilter {
  agentIds?: readonly string[];
  /** All must match. */
  labels?: Readonly<Record<string, string>>;
  types?: readonly EventType[];
  onlyNeedsAttention?: boolean;
}

export interface EventPage {
  events: AgentEvent[];
  nextCursor: string;
  /** The cursor was unknown or too old: events may be missing; `agents` holds the current state. */
  gap: boolean;
  /** More matching events are retained after nextCursor (the limit was hit). */
  more: boolean;
  /** Only on a gap: current state of the agents the filter covers. */
  agents?: AgentState[];
}

export interface EventHubOptions {
  /** Retained events. */
  capacity?: number;
  /** Events older than this are dropped. */
  ttlMs?: number;
  previewChars?: number;
  now?: () => number;
  epoch?: string;
}

/** Turn failures that are really a usage or rate limit. */
export function isLimitError(message: string | null | undefined): boolean {
  return !!message && /usage limit|rate.?limit|quota|limit reached|too many requests|\b429\b|overloaded/i.test(message);
}

export function matches(event: Pick<AgentEvent, "agentId" | "labels" | "type" | "requiresAttention">, filter: EventFilter): boolean {
  if (filter.agentIds?.length && !filter.agentIds.includes(event.agentId)) return false;
  if (filter.types?.length && !filter.types.includes(event.type)) return false;
  if (filter.onlyNeedsAttention && !event.requiresAttention) return false;
  for (const [k, v] of Object.entries(filter.labels ?? {})) if (event.labels[k] !== v) return false;
  return true;
}

function stateMatches(state: AgentState, filter: EventFilter): boolean {
  if (filter.agentIds?.length && !filter.agentIds.includes(state.agentId)) return false;
  if (filter.onlyNeedsAttention && !state.requiresAttention) return false;
  for (const [k, v] of Object.entries(filter.labels ?? {})) if (state.labels[k] !== v) return false;
  return true;
}

/** Merges two filters so both apply (e.g. a token's label filter and the caller's). */
export function andFilter(a: EventFilter, b: EventFilter | undefined): EventFilter {
  if (!b) return a;
  return {
    agentIds: a.agentIds ?? b.agentIds,
    types: a.types ?? b.types,
    onlyNeedsAttention: a.onlyNeedsAttention || b.onlyNeedsAttention,
    labels: { ...(a.labels ?? {}), ...(b.labels ?? {}) },
  };
}

export function parseCursor(cursor: string | undefined | null): { epoch: string; seq: number } | null {
  if (!cursor) return null;
  const m = /^([A-Za-z0-9_-]+):(\d+)$/.exec(cursor.trim());
  return m ? { epoch: m[1], seq: Number(m[2]) } : null;
}

type Listener = (event: AgentEvent) => void;

export class EventHub {
  readonly epoch: string;
  private seq = 0;
  private readonly events: AgentEvent[] = [];
  private readonly states = new Map<string, AgentState>();
  private readonly listeners = new Set<Listener>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  previewChars: number;

  constructor(options: EventHubOptions = {}) {
    this.capacity = options.capacity ?? 1000;
    this.ttlMs = options.ttlMs ?? 60 * 60_000;
    this.now = options.now ?? Date.now;
    this.previewChars = options.previewChars ?? 0;
    this.epoch = options.epoch ?? `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  }

  /** Cursor after the newest event. */
  cursor(): string {
    return `${this.epoch}:${this.seq}`;
  }

  state(agentId: string): AgentState | undefined {
    return this.states.get(agentId);
  }

  allStates(): AgentState[] {
    return [...this.states.values()];
  }

  /** Learns an agent's current state without publishing anything (initial snapshot, resync). */
  seed(state: Partial<AgentState> & { agentId: string }): AgentState {
    const prev = this.states.get(state.agentId);
    const next: AgentState = {
      agentId: state.agentId,
      title: state.title ?? prev?.title ?? null,
      status: state.status ?? prev?.status ?? null,
      labels: state.labels ?? prev?.labels ?? {},
      requiresAttention: state.requiresAttention ?? prev?.requiresAttention ?? false,
      attentionReason: state.attentionReason !== undefined ? state.attentionReason : (prev?.attentionReason ?? null),
      inTurn: state.inTurn ?? prev?.inTurn ?? false,
      pendingPermissions: state.pendingPermissions ?? prev?.pendingPermissions ?? [],
      archived: state.archived ?? prev?.archived ?? false,
      closed: state.closed ?? prev?.closed ?? false,
      updatedAt: new Date(this.now()).toISOString(),
      lastHookAt: state.lastHookAt ?? prev?.lastHookAt,
    };
    this.states.set(state.agentId, next);
    return next;
  }

  /** Whether this input would change the agent's state, i.e. is not a duplicate. */
  private isNew(input: EventInput, prev: AgentState | undefined): boolean {
    switch (input.type) {
      case "agent.created":
        return !prev;
      case "agent.turn_started":
        return !prev?.inTurn;
      case "agent.turn_ended":
        return prev?.inTurn !== false;
      case "agent.permission_requested":
        return !!input.permission && !prev?.pendingPermissions.some((p) => p.requestId === input.permission!.requestId);
      case "agent.permission_resolved":
        return !!input.permission && (!prev || prev.pendingPermissions.some((p) => p.requestId === input.permission!.requestId));
      case "agent.archived":
        return !prev?.archived;
      case "agent.closed":
        return !prev?.closed;
    }
  }

  /** Publishes an event unless it repeats what the hub already knows. Returns it, or null. */
  publish(input: EventInput): AgentEvent | null {
    const prev = this.states.get(input.agentId);
    if (!this.isNew(input, prev)) {
      // Still learn fresher fields (title, labels) from the duplicate.
      if (prev) this.seed({ agentId: input.agentId, title: input.title ?? undefined, labels: input.labels, status: input.status ?? undefined });
      return null;
    }
    let pending = prev?.pendingPermissions ?? [];
    if (input.type === "agent.permission_requested" && input.permission) pending = [...pending, input.permission];
    if (input.type === "agent.permission_resolved" && input.permission) {
      pending = pending.filter((p) => p.requestId !== input.permission!.requestId);
    }
    const permission =
      input.type === "agent.permission_resolved" && input.permission
        ? (prev?.pendingPermissions.find((p) => p.requestId === input.permission!.requestId) ?? input.permission)
        : input.permission;
    const inTurn =
      input.type === "agent.turn_started" ? true : input.type === "agent.turn_ended" || input.type === "agent.closed" ? false : prev?.inTurn;
    const requiresAttention =
      input.requiresAttention ??
      (input.type === "agent.permission_requested" || input.type === "agent.turn_ended"
        ? true
        : input.type === "agent.turn_started"
          ? false
          : (prev?.requiresAttention ?? false));
    const attentionReason =
      input.attentionReason !== undefined
        ? input.attentionReason
        : input.type === "agent.permission_requested"
          ? "permission"
          : input.type === "agent.turn_ended"
            ? input.outcome === "finished" || input.outcome === undefined
              ? "finished"
              : "error"
            : input.type === "agent.turn_started"
              ? null
              : (prev?.attentionReason ?? null);
    const state = this.seed({
      agentId: input.agentId,
      title: input.title ?? undefined,
      status:
        input.status ??
        (input.type === "agent.turn_started"
          ? "running"
          : input.type === "agent.turn_ended"
            ? input.outcome === "error" || input.outcome === "limit"
              ? "error"
              : "idle"
            : input.type === "agent.closed"
              ? "closed"
              : undefined),
      labels: input.labels,
      requiresAttention,
      attentionReason,
      inTurn,
      pendingPermissions: pending,
      // A new turn means the agent is back (unarchived, session reopened).
      archived: input.type === "agent.archived" ? true : input.type === "agent.turn_started" ? false : undefined,
      closed: input.type === "agent.closed" ? true : input.type === "agent.turn_started" ? false : undefined,
      lastHookAt: input.source === "hook" ? new Date(this.now()).toISOString() : undefined,
    });

    this.seq += 1;
    const event: AgentEvent = {
      id: `${this.epoch}:${this.seq}`,
      epoch: this.epoch,
      seq: this.seq,
      type: input.type,
      at: input.at ?? new Date(this.now()).toISOString(),
      agentId: input.agentId,
      title: state.title,
      status: state.status,
      labels: state.labels,
      requiresAttention: state.requiresAttention,
      attentionReason: state.attentionReason,
      ...(input.type === "agent.turn_ended" ? { outcome: input.outcome ?? "finished", error: input.error ?? null } : {}),
      ...(permission ? { permission } : {}),
      ...(input.type === "agent.permission_resolved" ? { resolution: input.resolution ?? null } : {}),
      ...(input.preview && this.previewChars > 0
        ? { preview: { text: clip(input.preview, this.previewChars), untrusted: true as const } }
        : {}),
      source: input.source,
    };
    this.events.push(event);
    this.prune();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A failing listener must not stop the others.
      }
    }
    return event;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    let drop = Math.max(0, this.events.length - this.capacity);
    while (drop < this.events.length && Date.parse(this.events[drop].at) < cutoff) drop++;
    if (drop) this.events.splice(0, drop);
  }

  /** Events after the cursor that match. No cursor: start from now (no events, no gap). */
  since(cursor: string | undefined | null, filter: EventFilter = {}, limit = 100): EventPage {
    this.prune();
    if (!cursor) return { events: [], nextCursor: this.cursor(), gap: false, more: false };
    const parsed = parseCursor(cursor);
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    // Fine if the next event we would deliver is still retained (or none happened since).
    const gap = !parsed || parsed.epoch !== this.epoch || parsed.seq > this.seq || (parsed.seq < oldest - 1 && parsed.seq < this.seq);
    if (gap) {
      return {
        events: [],
        nextCursor: this.cursor(),
        gap: true,
        more: false,
        agents: this.allStates().filter((s) => stateMatches(s, filter)),
      };
    }
    const out: AgentEvent[] = [];
    let last = parsed.seq;
    let more = false;
    for (const event of this.events) {
      if (event.seq <= parsed.seq) continue;
      if (!matches(event, filter)) {
        if (out.length < limit) last = event.seq;
        continue;
      }
      if (out.length >= limit) {
        more = true;
        break;
      }
      out.push(event);
      last = event.seq;
    }
    if (!more) last = this.seq;
    return { events: out, nextCursor: `${this.epoch}:${last}`, gap: false, more };
  }

  /**
   * Returns at once when matching events follow the cursor (or on a gap); otherwise waits for the
   * first matching event, the timeout, or the abort signal (e.g. the session ended).
   */
  wait(cursor: string | undefined | null, filter: EventFilter, timeoutMs: number, limit = 100, signal?: AbortSignal): Promise<EventPage> {
    const start = cursor ?? this.cursor();
    const page = this.since(start, filter, limit);
    if (page.gap || page.events.length || timeoutMs <= 0 || signal?.aborted) return Promise.resolve(page);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(onEvent);
        signal?.removeEventListener("abort", done);
        // Batch everything that arrived in the meantime.
        resolve(this.since(start, filter, limit));
      };
      const onEvent = (event: AgentEvent) => {
        if (matches(event, filter)) queueMicrotask(done);
      };
      this.listeners.add(onEvent);
      timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
