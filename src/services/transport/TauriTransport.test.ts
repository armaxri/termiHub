import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { TauriTransport } from "./TauriTransport";
import type { Intent, IntentAck } from "./types";

const mockInvoke = vi.mocked(invoke);

function intent(kind: string): Intent {
  return { intentId: `i-${kind}`, kind, payload: {}, clientId: "c" };
}

function ack(intentId: string): IntentAck {
  return { intentId, status: "accepted", produced: [] } as unknown as IntentAck;
}

/** A controllable `invoke`: each call parks until the test settles it. */
function deferredInvoke() {
  const calls: Array<{
    kind: string;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  mockInvoke.mockImplementation((_cmd, args) => {
    const kind = (args as { intent: Intent }).intent.kind;
    return new Promise((resolve, reject) => {
      calls.push({ kind, resolve, reject });
    });
  });
  return calls;
}

/** Let queued promise continuations run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// #4826: the layout bridge sends a `layout.replaceGroups` seed and then the
// granular intent without awaiting the seed, trusting FIFO delivery. Tauri IPC
// (independent custom-protocol fetches) can reorder them on WebView2, so the
// transport must not issue the next intent before the previous one settled.
describe("TauriTransport intent ordering (#4826)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("invokes an idle dispatch synchronously", () => {
    const calls = deferredInvoke();
    void new TauriTransport("c").dispatch(intent("layout.addTab"));
    expect(calls.map((c) => c.kind)).toEqual(["layout.addTab"]);
  });

  it("holds a later intent until the earlier one has been acknowledged", async () => {
    const calls = deferredInvoke();
    const transport = new TauriTransport("c");

    const seed = transport.dispatch(intent("layout.replaceGroups"));
    const add = transport.dispatch(intent("layout.addTab"));
    await flush();
    // Only the seed is on the wire; the granular intent waits behind it.
    expect(calls.map((c) => c.kind)).toEqual(["layout.replaceGroups"]);

    calls[0].resolve(ack("i-layout.replaceGroups"));
    await expect(seed).resolves.toMatchObject({ intentId: "i-layout.replaceGroups" });
    await flush();
    expect(calls.map((c) => c.kind)).toEqual(["layout.replaceGroups", "layout.addTab"]);

    calls[1].resolve(ack("i-layout.addTab"));
    await expect(add).resolves.toMatchObject({ intentId: "i-layout.addTab" });
  });

  it("does not stall the queue when an earlier dispatch fails", async () => {
    const calls = deferredInvoke();
    const transport = new TauriTransport("c");

    const first = transport.dispatch(intent("a"));
    const second = transport.dispatch(intent("b"));
    calls[0].reject(new Error("ipc down"));
    await expect(first).rejects.toThrow("ipc down");
    await flush();

    expect(calls.map((c) => c.kind)).toEqual(["a", "b"]);
    calls[1].resolve(ack("i-b"));
    await expect(second).resolves.toMatchObject({ intentId: "i-b" });
  });

  it("returns to synchronous dispatch once the queue drains", async () => {
    const calls = deferredInvoke();
    const transport = new TauriTransport("c");

    const first = transport.dispatch(intent("a"));
    calls[0].resolve(ack("i-a"));
    await first;
    await flush();

    void transport.dispatch(intent("b"));
    expect(calls.map((c) => c.kind)).toEqual(["a", "b"]);
  });
});
