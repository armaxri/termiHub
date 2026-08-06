/**
 * Transfers bridge — the domain is region-authoritative (#2229). These tests
 * drive the bridge against the in-memory {@link FakeTransferTransport} store twin
 * and assert: it subscribes and fans the projected view out to listeners, caches
 * the latest view for synchronous reads, and dispatches the client-originated
 * `transfer.*` intents (which round-trip back into the projected view). Best-effort
 * dispatch never throws, even on a rejected ack.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Intent, IntentAck } from "@/services/transport";
import {
  currentTransfersView,
  dispatchTransferIntent,
  dispatchTransferIntentBestEffort,
  ensureTransfersSubscribed,
  onTransfersView,
  type TransfersView,
} from "./transfersBridge";
import {
  fakeTransferEntry,
  installTransferHarness,
  transfersView,
  type FakeTransferTransport,
} from "@/test/transferHarness";

let transport: FakeTransferTransport;
let teardown: () => void;

beforeEach(() => {
  ({ transport, teardown } = installTransferHarness());
});

afterEach(() => {
  teardown();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("subscription + fan-out", () => {
  it("fans the seeded region view out to listeners and caches it", async () => {
    const received: TransfersView[] = [];
    const unsubscribe = onTransfersView((v) => received.push(v));

    transport.seed(transfersView([fakeTransferEntry("t1")], true));
    await ensureTransfersSubscribed();

    expect(received[received.length - 1]).toEqual(currentTransfersView());
    expect(currentTransfersView().minimized).toBe(true);
    expect(Object.keys(currentTransfersView().queue)).toEqual(["t1"]);
    unsubscribe();
  });
});

describe("dispatchTransferIntent", () => {
  it("dispatches the client intents that round-trip into the projected view", async () => {
    transport.seed(transfersView([fakeTransferEntry("t1", { state: "completed", percent: 100 })]));
    await ensureTransfersSubscribed();

    await dispatchTransferIntent("transfer.clearCompleted", {});
    expect(currentTransfersView().queue).toEqual({});
    expect(transport.kinds()).toContain("transfer.clearCompleted");
  });

  it("seed is idempotent server-side (never clobbers an advanced row)", async () => {
    transport.seed(transfersView([fakeTransferEntry("t1", { state: "active", transferred: 800 })]));
    await ensureTransfersSubscribed();

    await dispatchTransferIntent("transfer.seed", {
      seed: { id: "t1", sessionId: "s", direction: "download", name: "t1.bin" },
    });
    // The existing (further-along) row is preserved.
    expect(currentTransfersView().queue.t1.transferred).toBe(800);
    expect(currentTransfersView().queue.t1.state).toBe("active");
  });

  it("reconcile settles a stuck non-terminal row from a terminal snapshot", async () => {
    transport.seed(transfersView([fakeTransferEntry("t1", { state: "active", percent: 50 })]));
    await ensureTransfersSubscribed();

    await dispatchTransferIntent("transfer.reconcile", {
      snapshots: [
        {
          transferId: "t1",
          sessionId: "sess-t1",
          direction: "download",
          fileName: "t1.bin",
          state: "completed",
          transferred: 1000,
          total: 1000,
          speed: 0,
          settled: true,
        },
      ],
    });
    expect(currentTransfersView().queue.t1.state).toBe("completed");
    expect(currentTransfersView().queue.t1.percent).toBe(100);
  });
});

describe("dispatchTransferIntentBestEffort", () => {
  it("swallows a rejected ack without throwing", async () => {
    vi.spyOn(transport, "dispatch").mockResolvedValue({
      intentId: "x",
      status: "rejected",
      error: { message: "nope" },
      produced: [],
    } as unknown as IntentAck);
    expect(() => dispatchTransferIntentBestEffort("transfer.remove", { id: "gone" })).not.toThrow();
    await flush();
  });

  it("records the dispatched intent shape", async () => {
    await ensureTransfersSubscribed();
    dispatchTransferIntentBestEffort("transfer.setMinimized", { minimized: true });
    await flush();
    const last = transport.dispatched[transport.dispatched.length - 1] as Intent;
    expect(last.kind).toBe("transfer.setMinimized");
    expect(last.payload).toEqual({ minimized: true });
  });
});
