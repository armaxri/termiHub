/**
 * `useProjectedBroadcast` — reads the authoritative `broadcast@<clientId>` region
 * (#2206). Drives the hook against the in-memory {@link FakeBroadcastTransport}
 * double and asserts it renders the projected membership (as a `Set`), seeds from
 * the current view on mount, and re-renders on a region diff. There is no appStore
 * seed, mirror gate, or fallback — the region is the source of truth.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installBroadcastHarness, type FakeBroadcastTransport } from "@/test/broadcastHarness";
import { type BroadcastSlice } from "./broadcastBridge";
import { useProjectedBroadcast } from "./useProjectedBroadcast";

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => BroadcastSlice; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: BroadcastSlice = {
    active: false,
    sourceTabId: null,
    scope: "all",
    targetTabIds: new Set(),
    lastScope: "all",
  };

  function Probe() {
    latest = useProjectedBroadcast();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let harness: ReturnType<typeof installBroadcastHarness>;
let transport: FakeBroadcastTransport;

beforeEach(() => {
  harness = installBroadcastHarness();
  transport = harness.transport;
});

afterEach(() => {
  harness.teardown();
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedBroadcast", () => {
  it("renders the idle baseline when the region is empty", async () => {
    const hook = renderHook();
    await flush();

    expect(hook.get().active).toBe(false);
    expect(hook.get().targetTabIds.size).toBe(0);
    hook.unmount();
  });

  it("renders the projected membership as a Set", async () => {
    transport.seed({
      active: true,
      sourceTabId: "src",
      scope: "custom",
      targetTabIds: ["src", "t1", "t2"],
      lastScope: "custom",
    });

    const hook = renderHook();
    await flush();

    const s = hook.get();
    expect(s.active).toBe(true);
    expect(s.sourceTabId).toBe("src");
    expect(s.scope).toBe("custom");
    expect(s.targetTabIds).toBeInstanceOf(Set);
    expect([...s.targetTabIds].sort()).toEqual(["src", "t1", "t2"]);
    expect(s.lastScope).toBe("custom");
    hook.unmount();
  });

  it("re-renders on a region diff (a dispatched intent)", async () => {
    const hook = renderHook();
    await flush();
    expect(hook.get().active).toBe(false);

    await act(async () => {
      await transport.dispatch({
        intentId: "i1",
        kind: "broadcast.start",
        payload: { scope: "all", sourceTabId: "src", targetTabIds: ["t1"] },
        clientId: "c1",
      });
    });

    const s = hook.get();
    expect(s.active).toBe(true);
    expect(s.sourceTabId).toBe("src");
    expect([...s.targetTabIds].sort()).toEqual(["src", "t1"]);
    hook.unmount();
  });
});
