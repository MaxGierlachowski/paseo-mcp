/**
 * Per-session store of the messages sent on the SSE streams, so a client that lost its GET stream
 * can reconnect with Last-Event-ID and receive what it missed. Bounded: the oldest are dropped.
 */
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export class BoundedEventStore implements EventStore {
  private readonly entries: { id: string; streamId: string; message: JSONRPCMessage }[] = [];
  private counter = 0;

  constructor(private readonly capacity = 500) {}

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const id = `${streamId}_${++this.counter}`;
    this.entries.push({ id, streamId, message });
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return id;
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return this.entries.find((e) => e.id === eventId)?.streamId ?? eventId.slice(0, eventId.lastIndexOf("_")) ?? undefined;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const index = this.entries.findIndex((e) => e.id === lastEventId);
    const streamId = index >= 0 ? this.entries[index].streamId : lastEventId.slice(0, lastEventId.lastIndexOf("_"));
    for (const entry of this.entries.slice(index + 1)) {
      if (entry.streamId === streamId) await send(entry.id, entry.message);
    }
    return streamId;
  }
}
