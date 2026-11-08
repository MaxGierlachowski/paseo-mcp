// Unit tests for the EventHub, the snapshot differ and long-polling. Run after `npm run build`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventHub, andFilter, isLimitError, parseCursor } from "../dist/events.js";
import { diff, isStale, stateOf } from "../dist/agent-source.js";

const turn = (hub, agentId, source = "hook", extra = {}) => [
  hub.publish({ type: "agent.turn_started", agentId, source }),
  hub.publish({ type: "agent.turn_ended", agentId, source, outcome: "finished", ...extra }),
];

test("cursor is epoch:seq and counts up", () => {
  const hub = new EventHub({ epoch: "e1" });
  assert.equal(hub.cursor(), "e1:0");
  const e = hub.publish({ type: "agent.created", agentId: "a", source: "hook" });
  assert.equal(e.id, "e1:1");
  assert.equal(e.seq, 1);
  assert.equal(hub.cursor(), "e1:1");
  assert.deepEqual(parseCursor("e1:12"), { epoch: "e1", seq: 12 });
  assert.equal(parseCursor("nonsense"), null);
});

test("since: events after the cursor, in order", () => {
  const hub = new EventHub({ epoch: "e" });
  const start = hub.cursor();
  hub.publish({ type: "agent.created", agentId: "a", source: "hook" });
  turn(hub, "a");
  const page = hub.since(start);
  assert.deepEqual(page.events.map((e) => e.type), ["agent.created", "agent.turn_started", "agent.turn_ended"]);
  assert.equal(page.nextCursor, "e:3");
  assert.equal(page.gap, false);
  assert.equal(hub.since(page.nextCursor).events.length, 0);
});

test("no cursor: start from now, no gap", () => {
  const hub = new EventHub({ epoch: "e" });
  hub.publish({ type: "agent.created", agentId: "a", source: "hook" });
  const page = hub.since(undefined);
  assert.deepEqual(page, { events: [], nextCursor: "e:1", gap: false, more: false });
});

test("foreign or future cursor is a gap with the current state", () => {
  const hub = new EventHub({ epoch: "now" });
  hub.publish({ type: "agent.created", agentId: "a", source: "hook", labels: { origin: "hermes" } });
  hub.publish({ type: "agent.created", agentId: "b", source: "hook", labels: { origin: "other" } });
  for (const cursor of ["before-restart:5", "now:99", "garbage"]) {
    const page = hub.since(cursor, { labels: { origin: "hermes" } });
    assert.equal(page.gap, true, cursor);
    assert.equal(page.events.length, 0);
    assert.equal(page.nextCursor, "now:2");
    assert.deepEqual(page.agents.map((s) => s.agentId), ["a"]);
  }
});

test("capacity: a cursor older than the retained events is a gap", () => {
  const hub = new EventHub({ epoch: "e", capacity: 3 });
  const start = hub.cursor();
  for (const id of ["a", "b", "c", "d", "e"]) hub.publish({ type: "agent.created", agentId: id, source: "hook" });
  assert.equal(hub.since(start).gap, true);
  // e:2 still has its next event (e:3) retained.
  assert.equal(hub.since("e:2").gap, false);
  assert.equal(hub.since("e:2").events.length, 3);
  assert.equal(hub.since("e:1").gap, true);
});

test("TTL: expired events are dropped, so old cursors become gaps", () => {
  let now = Date.parse("2026-11-08T10:00:00Z");
  const hub = new EventHub({ epoch: "e", ttlMs: 60_000, now: () => now });
  const start = hub.cursor();
  hub.publish({ type: "agent.created", agentId: "a", source: "hook" });
  now += 30_000;
  hub.publish({ type: "agent.created", agentId: "b", source: "hook" });
  assert.equal(hub.since(start).events.length, 2);
  now += 45_000; // first is 75 s old, second 45 s
  assert.equal(hub.since(start).gap, true);
  assert.deepEqual(hub.since("e:1").events.map((e) => e.agentId), ["b"]);
});

test("filters: agent ids, labels, types, needs attention", () => {
  const hub = new EventHub({ epoch: "e" });
  const start = hub.cursor();
  hub.publish({ type: "agent.created", agentId: "a", source: "hook", labels: { origin: "hermes" } });
  hub.publish({ type: "agent.created", agentId: "b", source: "hook", labels: { origin: "x" } });
  turn(hub, "a");
  hub.publish({ type: "agent.permission_requested", agentId: "b", source: "hook", permission: { requestId: "r1", name: "Bash", title: "rm", kind: "tool" } });
  const types = (f) => hub.since(start, f).events.map((e) => `${e.agentId}:${e.type}`);
  assert.deepEqual(types({ agentIds: ["b"] }), ["b:agent.created", "b:agent.permission_requested"]);
  assert.deepEqual(types({ labels: { origin: "hermes" } }), ["a:agent.created", "a:agent.turn_started", "a:agent.turn_ended"]);
  assert.deepEqual(types({ types: ["agent.turn_ended"] }), ["a:agent.turn_ended"]);
  assert.deepEqual(types({ onlyNeedsAttention: true }), ["a:agent.turn_ended", "b:agent.permission_requested"]);
  // Labels learned from created stay on later events.
  assert.deepEqual(hub.since(start, { types: ["agent.turn_ended"] }).events[0].labels, { origin: "hermes" });
});

test("limit: more=true and the cursor stops at the last returned event", () => {
  const hub = new EventHub({ epoch: "e" });
  const start = hub.cursor();
  for (const id of ["a", "b", "c"]) hub.publish({ type: "agent.created", agentId: id, source: "hook" });
  const first = hub.since(start, {}, 2);
  assert.equal(first.events.length, 2);
  assert.equal(first.more, true);
  assert.equal(first.nextCursor, "e:2");
  const second = hub.since(first.nextCursor, {}, 2);
  assert.deepEqual(second.events.map((e) => e.agentId), ["c"]);
  assert.equal(second.more, false);
});

test("dedupe: hook and push report the same happening once", () => {
  const hub = new EventHub({ epoch: "e" });
  const start = hub.cursor();
  assert.ok(hub.publish({ type: "agent.created", agentId: "a", source: "hook" }));
  assert.equal(hub.publish({ type: "agent.created", agentId: "a", source: "client" }), null);
  assert.ok(hub.publish({ type: "agent.turn_started", agentId: "a", source: "client" }));
  assert.equal(hub.publish({ type: "agent.turn_started", agentId: "a", source: "hook" }), null);
  const perm = { requestId: "r1", name: "Bash", title: null, kind: "tool" };
  assert.ok(hub.publish({ type: "agent.permission_requested", agentId: "a", source: "hook", permission: perm }));
  assert.equal(hub.publish({ type: "agent.permission_requested", agentId: "a", source: "client", permission: perm }), null);
  assert.ok(hub.publish({ type: "agent.permission_resolved", agentId: "a", source: "hook", permission: { ...perm, name: null }, resolution: "allow" }));
  assert.equal(hub.publish({ type: "agent.permission_resolved", agentId: "a", source: "client", permission: perm }), null);
  assert.ok(hub.publish({ type: "agent.turn_ended", agentId: "a", source: "hook", outcome: "finished" }));
  assert.equal(hub.publish({ type: "agent.turn_ended", agentId: "a", source: "client", outcome: "finished" }), null);
  // A second, quick turn is still reported.
  assert.ok(hub.publish({ type: "agent.turn_started", agentId: "a", source: "hook" }));
  const events = hub.since(start).events;
  assert.equal(events.length, 6);
  // The resolved event keeps the name from the request.
  assert.equal(events.find((e) => e.type === "agent.permission_resolved").permission.name, "Bash");
  assert.equal(events.find((e) => e.type === "agent.permission_resolved").resolution, "allow");
});

test("turn_ended carries outcome and attention; limit errors are recognised", () => {
  const hub = new EventHub({ epoch: "e" });
  const [, ended] = turn(hub, "a", "hook", { outcome: "error", error: "boom" });
  assert.equal(ended.outcome, "error");
  assert.equal(ended.requiresAttention, true);
  assert.equal(ended.attentionReason, "error");
  assert.equal(ended.status, "error");
  assert.ok(isLimitError("Claude usage limit reached, resets at 5pm"));
  assert.ok(isLimitError("429 Too Many Requests"));
  assert.ok(!isLimitError("ENOENT"));
});

test("preview is opt-in, clipped and marked untrusted", () => {
  const off = new EventHub({ epoch: "e" });
  const [, a] = turn(off, "a", "hook", { preview: "secret output" });
  assert.equal(a.preview, undefined);
  const on = new EventHub({ epoch: "e", previewChars: 10 });
  const [, b] = turn(on, "a", "hook", { preview: "Done.\n\nAll   tests pass now." });
  assert.deepEqual(b.preview, { text: "Done. All …", untrusted: true });
});

test("andFilter combines a token filter with the caller's", () => {
  const f = andFilter({ labels: { a: "1" }, types: ["agent.created"] }, { labels: { origin: "hermes" }, onlyNeedsAttention: true });
  assert.deepEqual(f.labels, { a: "1", origin: "hermes" });
  assert.equal(f.onlyNeedsAttention, true);
  // The token's labels win over a caller trying to widen them.
  assert.deepEqual(andFilter({ labels: { origin: "x" } }, { labels: { origin: "hermes" } }).labels, { origin: "hermes" });
});

// ---------------------------------------------------------------- long-poll

test("wait returns at once when events are pending", async () => {
  const hub = new EventHub({ epoch: "e" });
  const start = hub.cursor();
  hub.publish({ type: "agent.created", agentId: "a", source: "hook" });
  const t = Date.now();
  const page = await hub.wait(start, {}, 5000);
  assert.equal(page.events.length, 1);
  assert.ok(Date.now() - t < 100);
});

test("wait blocks until a matching event, ignoring others", async () => {
  const hub = new EventHub({ epoch: "e" });
  const start = hub.cursor();
  setTimeout(() => hub.publish({ type: "agent.created", agentId: "other", source: "hook" }), 20);
  setTimeout(() => hub.publish({ type: "agent.created", agentId: "a", source: "hook" }), 60);
  const t = Date.now();
  const page = await hub.wait(start, { agentIds: ["a"] }, 5000);
  assert.deepEqual(page.events.map((e) => e.agentId), ["a"]);
  assert.ok(Date.now() - t >= 50);
  assert.equal(page.nextCursor, "e:2");
  assert.equal(hub.listenerCount(), 0);
});

test("wait times out with no events and an advanced cursor", async () => {
  const hub = new EventHub({ epoch: "e" });
  const start = hub.cursor();
  setTimeout(() => hub.publish({ type: "agent.created", agentId: "other", source: "hook" }), 10);
  const t = Date.now();
  const page = await hub.wait(start, { agentIds: ["a"] }, 80);
  assert.equal(page.events.length, 0);
  assert.equal(page.gap, false);
  assert.equal(page.nextCursor, "e:1");
  assert.ok(Date.now() - t >= 75);
});

test("wait with timeout 0 returns at once", async () => {
  const hub = new EventHub({ epoch: "e" });
  const page = await hub.wait(hub.cursor(), {}, 0);
  assert.deepEqual(page.events, []);
});

test("wait ends when the signal aborts (session closed)", async () => {
  const hub = new EventHub({ epoch: "e" });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const t = Date.now();
  const page = await hub.wait(hub.cursor(), {}, 10_000, 50, ac.signal);
  assert.equal(page.events.length, 0);
  assert.ok(Date.now() - t < 1000);
  assert.equal(hub.listenerCount(), 0);
});

// ---------------------------------------------------------------- snapshot differ

const snap = (over = {}) => ({
  id: "a",
  title: "T",
  status: "idle",
  labels: { origin: "hermes" },
  requiresAttention: false,
  attentionReason: null,
  pendingPermissions: [],
  archivedAt: null,
  lastError: null,
  updatedAt: new Date().toISOString(),
  ...over,
});

function play(hub, ...snaps) {
  for (const s of snaps) {
    // Like ClientEventSource.apply.
    for (const input of diff(hub.state(s.id), s)) hub.publish(input);
    if (!isStale(hub.state(s.id), s)) hub.seed(stateOf(s));
  }
}

test("differ: created → turn_started → permission → resolved → turn_ended → archived", () => {
  const hub = new EventHub({ epoch: "e" });
  const start = hub.cursor();
  const p = { id: "r1", name: "Bash", title: "ls", kind: "tool" };
  play(
    hub,
    snap({ status: "initializing" }),
    snap({ status: "running" }),
    snap({ status: "running", pendingPermissions: [p], requiresAttention: true, attentionReason: "permission" }),
    snap({ status: "running" }),
    snap({ status: "idle", requiresAttention: true, attentionReason: "finished" }),
    snap({ status: "idle", archivedAt: "2026-11-08T10:00:00Z" }),
  );
  assert.deepEqual(hub.since(start).events.map((e) => e.type), [
    "agent.created",
    "agent.turn_started",
    "agent.permission_requested",
    "agent.permission_resolved",
    "agent.turn_ended",
    "agent.archived",
  ]);
});

test("differ: error with a usage limit is outcome=limit", () => {
  const hub = new EventHub({ epoch: "e" });
  hub.seed(stateOf(snap({ status: "running" })));
  const start = hub.cursor();
  play(hub, snap({ status: "error", lastError: "You've hit your usage limit" }));
  const [e] = hub.since(start).events;
  assert.equal(e.type, "agent.turn_ended");
  assert.equal(e.outcome, "limit");
  assert.equal(e.error, "You've hit your usage limit");
});

test("differ: a push snapshot older than the last hook report is ignored", () => {
  const hub = new EventHub({ epoch: "e" });
  hub.publish({ type: "agent.created", agentId: "a", source: "hook" });
  hub.publish({ type: "agent.turn_started", agentId: "a", source: "hook" });
  hub.publish({ type: "agent.turn_ended", agentId: "a", source: "hook", outcome: "finished" });
  const start = hub.cursor();
  play(hub, snap({ status: "running", updatedAt: new Date(Date.now() - 5000).toISOString() }));
  assert.equal(hub.since(start).events.length, 0);
  assert.equal(hub.state("a").inTurn, false);
});

test("differ: a later snapshot does not undo a reported close or archive", () => {
  const hub = new EventHub({ epoch: "e" });
  play(hub, snap({ status: "running" }), snap({ status: "closed" }));
  const start = hub.cursor();
  play(hub, snap({ status: "idle", updatedAt: new Date(Date.now() + 1000).toISOString() }));
  assert.equal(hub.publish({ type: "agent.closed", agentId: "a", source: "hook" }), null, "no second closed");
  play(hub, snap({ status: "idle", archivedAt: "2026-11-08T10:00:00Z" }), snap({ status: "idle" }));
  assert.equal(hub.publish({ type: "agent.archived", agentId: "a", source: "hook" }), null, "no second archived");
  assert.deepEqual(hub.since(start).events.map((e) => e.type), ["agent.archived"]);
  // Back to work: a new turn clears both.
  play(hub, snap({ status: "running" }));
  assert.ok(hub.publish({ type: "agent.closed", agentId: "a", source: "hook" }));
});
