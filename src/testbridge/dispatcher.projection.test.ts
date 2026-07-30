import { describe, expect, it, vi } from "vitest";

import { dispatchCommand, type BridgeDeps, type ProjectionApi } from "./dispatcher";
import type { ProjectionRecordingState } from "./projectionRecorder";

/** Minimal deps with a stubbed projection recorder (the only dep these verbs use). */
function setup(projection?: ProjectionApi): BridgeDeps {
  return {
    root: document,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "",
    emitEvent: async () => {},
    projection,
  };
}

const state = (overrides: Partial<ProjectionRecordingState> = {}): ProjectionRecordingState => ({
  subscriptionId: "harness:diag.counter:0",
  region: "diag.counter",
  snapshot: { region: "diag.counter", kind: "snapshot", version: 0, view: {} },
  frames: [],
  cache: { version: 0, view: {} },
  dropRemaining: 0,
  ...overrides,
});

describe("dispatchCommand — projection verbs", () => {
  it("subscribe returns the recording state", async () => {
    const projection = { subscribe: vi.fn(async () => state()) } as unknown as ProjectionApi;
    const res = await dispatchCommand(
      { action: "projectionSubscribe", region: "diag.counter" },
      setup(projection)
    );
    expect(res.ok).toBe(true);
    expect(res.value).toEqual(state());
    expect(projection.subscribe).toHaveBeenCalledWith("diag.counter");
  });

  it("dispatch forwards intent fields and returns the ack", async () => {
    const ack = { intentId: "i1", status: "accepted" as const, produced: [] };
    const dispatch = vi.fn(async () => ack);
    const res = await dispatchCommand(
      { action: "projectionDispatch", kind: "diag.increment", payload: { by: 2 } },
      setup({ dispatch } as unknown as ProjectionApi)
    );
    expect(res).toEqual({ ok: true, action: "projectionDispatch", value: ack });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "diag.increment",
      payload: { by: 2 },
      intentId: undefined,
      clientId: undefined,
    });
  });

  it("dropNext forwards the count", async () => {
    const dropNext = vi.fn();
    const res = await dispatchCommand(
      { action: "projectionDropNext", subscriptionId: "s0", count: 2 },
      setup({ dropNext } as unknown as ProjectionApi)
    );
    expect(res).toEqual({ ok: true, action: "projectionDropNext" });
    expect(dropNext).toHaveBeenCalledWith("s0", 2);
  });

  it("surfaces a recorder error as ok:false", async () => {
    const projection = {
      state: vi.fn(() => {
        throw new Error('no projection subscription "s9"');
      }),
    } as unknown as ProjectionApi;
    const res = await dispatchCommand(
      { action: "projectionState", subscriptionId: "s9" },
      setup(projection)
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no projection subscription");
  });

  it("fails cleanly when the recorder is not wired", async () => {
    const res = await dispatchCommand(
      { action: "projectionSubscribe", region: "diag.counter" },
      setup(undefined)
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not available");
  });
});
