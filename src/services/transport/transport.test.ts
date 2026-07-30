import { describe, expect, it, vi } from "vitest";

import { createTransport, isTauri } from "./index";
import { WebSocketTransport, type JsonRpcSocket } from "./WebSocketTransport";
import type { DiffFrame, IntentAck, SnapshotFrame } from "./types";

class FakeSocket implements JsonRpcSocket {
  requests: Array<{ method: string; params: unknown }> = [];
  responses = new Map<string, unknown>();
  private notifHandlers = new Map<string, (p: unknown) => void>();

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    return this.responses.get(method) as T;
  }

  onNotification(method: string, handler: (p: unknown) => void): () => void {
    this.notifHandlers.set(method, handler);
    return () => this.notifHandlers.delete(method);
  }

  emitNotification(method: string, params: unknown): void {
    this.notifHandlers.get(method)?.(params);
  }
}

const snapshot: SnapshotFrame = {
  region: "tunnels",
  kind: "snapshot",
  version: 41,
  view: { tunnels: [] },
};

describe("WebSocketTransport", () => {
  it("dispatches an intent as a JSON-RPC request", async () => {
    const socket = new FakeSocket();
    const ack: IntentAck = { intentId: "i1", status: "accepted", produced: [] };
    socket.responses.set("intent.dispatch", ack);
    const transport = new WebSocketTransport(socket, "client-1");

    const intent = {
      intentId: "i1",
      kind: "tunnel.start",
      payload: { id: "t2" },
      clientId: "client-1",
    };
    const result = await transport.dispatch(intent);

    expect(result).toEqual(ack);
    expect(socket.requests).toEqual([{ method: "intent.dispatch", params: { intent } }]);
  });

  it("routes projection.frame notifications to the subscribing region only", async () => {
    const socket = new FakeSocket();
    socket.responses.set("projection.subscribe", snapshot);
    const transport = new WebSocketTransport(socket, "client-1");

    const frames: DiffFrame[] = [];
    const sub = await transport.subscribe("tunnels", (f) => frames.push(f as DiffFrame));
    expect(sub.snapshot).toEqual(snapshot);

    const diff: DiffFrame = {
      region: "tunnels",
      kind: "diff",
      baseVersion: 41,
      version: 42,
      ops: [{ op: "replace", path: "/tunnels/0/status", value: "connecting" }],
    };
    socket.emitNotification("projection.frame", diff);
    socket.emitNotification("projection.frame", { ...diff, region: "servers" });
    expect(frames).toEqual([diff]);

    // Unsubscribe stops delivery and tells the server.
    sub.unsubscribe();
    expect(socket.requests[socket.requests.length - 1]?.method).toBe("projection.unsubscribe");
    socket.emitNotification("projection.frame", diff);
    expect(frames).toHaveLength(1);
  });

  it("passes the held version to resync", async () => {
    const socket = new FakeSocket();
    socket.responses.set("projection.resync", snapshot);
    const transport = new WebSocketTransport(socket, "client-1");

    const result = await transport.resync("tunnels", 40);
    expect(result).toEqual(snapshot);
    expect(socket.requests).toEqual([
      { method: "projection.resync", params: { region: "tunnels", have: 40 } },
    ]);
  });
});

describe("createTransport selector", () => {
  it("reports a non-Tauri environment under jsdom", () => {
    expect(isTauri()).toBe(false);
  });

  it("throws without a socket when not in Tauri", () => {
    expect(() => createTransport()).toThrow(/socket/i);
  });

  it("builds a WebSocketTransport over a supplied socket", () => {
    const socket = new FakeSocket();
    expect(createTransport({ socket })).toBeInstanceOf(WebSocketTransport);
  });

  it("selects TauriTransport when the Tauri global is present", () => {
    vi.stubGlobal("window", { __TAURI__: {} });
    try {
      expect(isTauri()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
