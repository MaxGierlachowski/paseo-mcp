#!/usr/bin/env node
// A tiny Agent Client Protocol agent for the Linux smoke test: Paseo runs it as a custom provider
// (extends "acp"), so agents can be created, prompted and asked for permissions without any model
// account. It answers every prompt with "echo: <prompt>"; a prompt containing "ask permission"
// first requests a permission and reports the answer.
import { createInterface } from "node:readline";

let nextId = 1;
let sessions = 0;
const pending = new Map();
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const notify = (method, params) => send({ method, params });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `echo-${nextId++}`;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const say = (sessionId, text) =>
  notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });

async function handle(method, params) {
  switch (method) {
    case "initialize":
      return { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {} }, authMethods: [] };
    case "session/new":
      return { sessionId: `echo-session-${++sessions}` };
    case "session/prompt": {
      const { sessionId } = params;
      const text = (params.prompt ?? []).map((p) => p.text ?? "").join(" ").trim();
      if (/ask permission/i.test(text)) {
        const toolCall = { toolCallId: `call-${nextId}`, title: "Run echo", kind: "execute", status: "pending" };
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", ...toolCall } });
        const answer = await request("session/request_permission", {
          sessionId,
          toolCall,
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        const chosen = answer?.outcome?.optionId ?? answer?.outcome?.outcome ?? "none";
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: "completed" } });
        say(sessionId, `permission: ${chosen}. `);
      }
      say(sessionId, `echo: ${text}`);
      return { stopReason: "end_turn" };
    }
    default:
      return {};
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method && msg.id !== undefined) {
    handle(msg.method, msg.params ?? {}).then(
      (result) => send({ id: msg.id, result }),
      (e) => send({ id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }),
    );
  } else if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
  // Notifications (session/cancel, …) need no answer.
});
