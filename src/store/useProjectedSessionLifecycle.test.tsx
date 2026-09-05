/**
 * `useProjectedSessionLifecycle` / `useProjectedSessionLifecycleMaps` — the
 * terminal lifecycle status readers. Connect / reconnect status AND the disconnect
 * error are sourced **purely** from the projected `session-lifecycle` region
 * (#2205 PR-B removed the reconnect engine; #2625 deleted the per-client
 * `terminalDisconnectErrors` slice). Drives the hooks against the in-memory region
 * harness and asserts they reflect the region as the single source of truth.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  connecting,
  connected,
  failed,
  flushSessionRegion,
  installSessionLifecycleHarness,
  reconnecting,
  sessionLost,
} from "@/test/sessionLifecycleRegionTestHarness";

import {
  useProjectedSessionLifecycle,
  useProjectedSessionLifecycleMaps,
  type ProjectedSessionLifecycleMaps,
  type ProjectedSessionLifecycleSlice,
} from "./useSessionLifecycle";

const TAB = "tab-1";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("useProjectedSessionLifecycle (per tab)", () => {
  const harness = installSessionLifecycleHarness();

  function Probe({ onValue }: { onValue: (v: ProjectedSessionLifecycleSlice) => void }) {
    onValue(useProjectedSessionLifecycle(TAB));
    return null;
  }

  it("sources connecting from a mirroring projected snapshot", async () => {
    harness.transport.setSession(TAB, connecting());
    let latest: ProjectedSessionLifecycleSlice | undefined;
    mount(<Probe onValue={(v) => (latest = v)} />);
    await flushSessionRegion();

    expect(harness.transport.subscribeCount).toBeGreaterThan(0);
    expect(latest?.connecting).toBe(true);
  });

  it("sources reconnecting and the disconnect error from mirroring snapshots", async () => {
    harness.transport.setSession(
      TAB,
      reconnecting({ phase: "waiting", attempt: 1, delayMs: 3000 })
    );
    let latest: ProjectedSessionLifecycleSlice | undefined;
    mount(<Probe onValue={(v) => (latest = v)} />);
    await flushSessionRegion();
    expect(latest?.reconnecting).toBe(true);

    // Now a failed disconnect — the region carries the error (region-only, #2625).
    act(() => harness.transport.setSession(TAB, failed("auth failed")));
    await flushSessionRegion();
    expect(latest?.disconnectError).toBe("auth failed");
  });

  it("reflects the region as the sole source (no appStore fallback)", async () => {
    // The region is authoritative since the engine was removed: a connected
    // snapshot means not-connecting, regardless of any stale local field.
    harness.transport.setSession(TAB, connected());
    let latest: ProjectedSessionLifecycleSlice | undefined;
    mount(<Probe onValue={(v) => (latest = v)} />);
    await flushSessionRegion();
    expect(latest?.connecting).toBe(false);
  });
});

describe("useProjectedSessionLifecycle — always region-sourced", () => {
  // The readers always subscribe and read the region (the migration flags that
  // once gated them are gone, #2283).
  const harness = installSessionLifecycleHarness();

  function Probe({ onValue }: { onValue: (v: ProjectedSessionLifecycleSlice) => void }) {
    onValue(useProjectedSessionLifecycle(TAB));
    return null;
  }

  it("subscribes and reads the region", async () => {
    harness.transport.setSession(TAB, connected());
    let latest: ProjectedSessionLifecycleSlice | undefined;
    mount(<Probe onValue={(v) => (latest = v)} />);
    await flushSessionRegion();
    expect(latest?.connecting).toBe(false);
    expect(harness.transport.subscribeCount).toBeGreaterThan(0);
  });
});

describe("useProjectedSessionLifecycleMaps (list consumers)", () => {
  const harness = installSessionLifecycleHarness();

  function Probe({ onValue }: { onValue: (v: ProjectedSessionLifecycleMaps) => void }) {
    onValue(useProjectedSessionLifecycleMaps());
    return null;
  }

  it("builds the maps purely from the region view", async () => {
    harness.transport.setSession("a", connecting());
    harness.transport.setSession(
      "b",
      reconnecting({ phase: "waiting", attempt: 0, delayMs: 1000 })
    );
    harness.transport.setSession("c", failed("boom"));
    let latest: ProjectedSessionLifecycleMaps | undefined;
    mount(<Probe onValue={(v) => (latest = v)} />);
    await flushSessionRegion();

    expect(harness.transport.subscribeCount).toBeGreaterThan(0);
    expect(latest?.terminalConnecting).toEqual({ a: true });
    expect(latest?.terminalReconnectingTabs).toEqual({ b: true });
    expect(latest?.terminalDisconnectErrors).toEqual({ c: "boom" });
  });

  it("exposes a terminalSessionLost map from the region (#2524)", async () => {
    // The tab-strip dot reads this so a session-lost tab never stays green (#2512).
    harness.transport.setSession("d", sessionLost("process ended"));
    harness.transport.setSession("e", connected());
    let latest: ProjectedSessionLifecycleMaps | undefined;
    mount(<Probe onValue={(v) => (latest = v)} />);
    await flushSessionRegion();

    expect(latest?.terminalSessionLost).toEqual({ d: true });
  });
});
