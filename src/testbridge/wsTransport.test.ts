import { describe, it, expect, vi } from "vitest";
import { WebSocketBridgeTransport, type BridgeChannel } from "./wsTransport";
import type { BridgeRequestEnvelope } from "./wsProtocol";

/** An in-memory {@link BridgeChannel} the test drives both ends of. */
class FakeChannel implements BridgeChannel {
  readonly sent: string[] = [];
  closed = false;
  private messageListener?: (data: string) => void;
  private closeListener?: () => void;

  send(data: string): void {
    this.sent.push(data);
  }

  onMessage(listener: (data: string) => void): void {
    this.messageListener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  close(): void {
    this.closed = true;
  }

  /** The n-th request envelope the transport sent. */
  request(index: number): BridgeRequestEnvelope {
    return JSON.parse(this.sent[index]) as BridgeRequestEnvelope;
  }

  /** Simulate a response frame arriving from the app. */
  reply(id: number, response: unknown): void {
    this.messageListener?.(JSON.stringify({ id, response }));
  }

  /** Simulate the underlying socket closing. */
  drop(): void {
    this.closeListener?.();
  }
}

function setup() {
  const channel = new FakeChannel();
  // Disable the request timeout so the correlation logic is what's under test.
  const transport = new WebSocketBridgeTransport(channel, { requestTimeoutMs: 0 });
  return { channel, transport };
}

describe("WebSocketBridgeTransport", () => {
  it("tags outgoing commands with increasing ids", () => {
    const { channel, transport } = setup();
    void transport.transport({ action: "click", testId: "a" });
    void transport.transport({ action: "click", testId: "b" });

    expect(channel.request(0)).toEqual({ id: 1, command: { action: "click", testId: "a" } });
    expect(channel.request(1)).toEqual({ id: 2, command: { action: "click", testId: "b" } });
  });

  it("resolves a command with the response carrying its id", async () => {
    const { channel, transport } = setup();
    const pending = transport.transport({ action: "getText", testId: "status" });

    channel.reply(1, { ok: true, action: "getText", value: "Connected" });

    await expect(pending).resolves.toEqual({ ok: true, action: "getText", value: "Connected" });
  });

  it("correlates out-of-order responses to the right command", async () => {
    const { channel, transport } = setup();
    const first = transport.transport({ action: "getText", testId: "a" });
    const second = transport.transport({ action: "getText", testId: "b" });

    // Reply to the second request before the first.
    channel.reply(2, { ok: true, action: "getText", value: "B" });
    channel.reply(1, { ok: true, action: "getText", value: "A" });

    await expect(first).resolves.toMatchObject({ value: "A" });
    await expect(second).resolves.toMatchObject({ value: "B" });
  });

  it("ignores responses with an unknown id", async () => {
    const { channel, transport } = setup();
    const pending = transport.transport({ action: "exists", testId: "x" });

    channel.reply(999, { ok: true, action: "exists", value: false }); // stale/unknown
    channel.reply(1, { ok: true, action: "exists", value: true });

    await expect(pending).resolves.toMatchObject({ value: true });
  });

  it("rejects in-flight commands when the connection drops", async () => {
    const { channel, transport } = setup();
    const pending = transport.transport({ action: "getState" });

    channel.drop();

    await expect(pending).rejects.toThrow(/closed/i);
  });

  it("rejects new commands after close()", async () => {
    const { channel, transport } = setup();
    transport.close();
    expect(channel.closed).toBe(true);
    await expect(transport.transport({ action: "getState" })).rejects.toThrow(/closed/i);
  });

  it("times out a command with no response", async () => {
    vi.useFakeTimers();
    try {
      const channel = new FakeChannel();
      const transport = new WebSocketBridgeTransport(channel, { requestTimeoutMs: 50 });
      const pending = transport.transport({ action: "getState" });
      const assertion = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
