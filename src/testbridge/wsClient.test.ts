import { describe, it, expect, vi } from "vitest";
import { runBridgeWebSocketClient } from "./wsClient";
import type { BridgeClientSocket } from "./wsClient";
import type { BridgeCommand, BridgeResponse } from "./protocol";
import type { BridgeResponseEnvelope } from "./wsProtocol";

/**
 * A fake of the browser WebSocket surface the client uses: it records sends and
 * lets the test push `message` events in, simulating the runner's WS server.
 */
class FakeSocket implements BridgeClientSocket {
  readonly sent: string[] = [];
  closed = false;
  closeCount = 0;
  /** Live listener registrations, keyed by type, for leak assertions. */
  readonly listeners = new Map<string, Set<(event: { data: unknown }) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.closeCount += 1;
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener as (event: { data: unknown }) => void);
  }

  /** Total number of currently-registered listeners across all types. */
  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  /** Simulate a message arriving from the runner. */
  emit(data: unknown): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const listener of this.listeners.get("message") ?? []) listener({ data: payload });
  }

  /** Parse the n-th sent frame as a response envelope. */
  sentEnvelope(index: number): BridgeResponseEnvelope {
    return JSON.parse(this.sent[index]) as BridgeResponseEnvelope;
  }
}

function setup(dispatch: (command: BridgeCommand) => BridgeResponse | Promise<BridgeResponse>) {
  const socket = new FakeSocket();
  const client = runBridgeWebSocketClient({
    url: "ws://127.0.0.1:1234",
    dispatch,
    createSocket: () => socket,
  });
  return { socket, client };
}

describe("runBridgeWebSocketClient", () => {
  it("dispatches an incoming command and replies with the matching id", async () => {
    const dispatch = vi.fn(
      (command: BridgeCommand): BridgeResponse => ({
        ok: true,
        action: command.action,
        value: "Connected",
      })
    );
    const { socket } = setup(dispatch);

    socket.emit({ id: 7, command: { action: "getText", testId: "status" } });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    expect(dispatch).toHaveBeenCalledWith({ action: "getText", testId: "status" });
    expect(socket.sentEnvelope(0)).toEqual({
      id: 7,
      response: { ok: true, action: "getText", value: "Connected" },
    });
  });

  it("preserves request ids across concurrent commands", async () => {
    const { socket } = setup((command) => ({ ok: true, action: command.action }));

    socket.emit({ id: 1, command: { action: "click", testId: "a" } });
    socket.emit({ id: 2, command: { action: "click", testId: "b" } });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));

    expect(socket.sentEnvelope(0).id).toBe(1);
    expect(socket.sentEnvelope(1).id).toBe(2);
  });

  it("forwards an ok:false dispatch result verbatim", async () => {
    const { socket } = setup(() => ({
      ok: false,
      action: "click",
      error: 'no element with data-testid="ghost"',
    }));

    socket.emit({ id: 3, command: { action: "click", testId: "ghost" } });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    expect(socket.sentEnvelope(0)).toEqual({
      id: 3,
      response: { ok: false, action: "click", error: 'no element with data-testid="ghost"' },
    });
  });

  it("turns a thrown dispatch into an ok:false response instead of crashing", async () => {
    const { socket } = setup(() => {
      throw new Error("boom");
    });

    socket.emit({ id: 4, command: { action: "getState" } });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const envelope = socket.sentEnvelope(0);
    expect(envelope.id).toBe(4);
    expect(envelope.response.ok).toBe(false);
    expect(envelope.response.error).toContain("boom");
  });

  it("ignores non-JSON and non-envelope frames", async () => {
    const dispatch = vi.fn(() => ({ ok: true, action: "exists" as const }));
    const { socket } = setup(dispatch);

    socket.emit("not json");
    socket.emit({ hello: "world" });
    socket.emit({ id: 9 }); // missing command

    expect(dispatch).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(0);
  });

  it("closes the underlying socket on close()", () => {
    const { socket, client } = setup(() => ({ ok: true, action: "exists" }));
    client.close();
    expect(socket.closed).toBe(true);
  });

  it("detaches every listener on close() so nothing leaks across a restart", () => {
    const socket = new FakeSocket();
    const client = runBridgeWebSocketClient({
      url: "ws://127.0.0.1:1234",
      dispatch: () => ({ ok: true, action: "exists" }),
      createSocket: () => socket,
      onOpen: () => {},
      onClose: () => {},
      onError: () => {},
    });
    expect(socket.listenerCount()).toBeGreaterThan(0);

    client.close();
    expect(socket.listenerCount()).toBe(0);
  });

  it("is idempotent — repeated close() closes the socket once", () => {
    const { socket, client } = setup(() => ({ ok: true, action: "exists" }));
    client.close();
    client.close();
    client.close();
    expect(socket.closeCount).toBe(1);
  });

  it("ignores messages that arrive after close()", async () => {
    const dispatch = vi.fn(() => ({ ok: true, action: "exists" as const }));
    const { socket, client } = setup(dispatch);
    client.close();

    socket.emit({ id: 1, command: { action: "getText", testId: "x" } });

    expect(dispatch).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(0);
  });
});
