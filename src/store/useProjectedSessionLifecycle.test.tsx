/**
 * `useProjectedSessionLifecycle` / `useProjectedSessionLifecycleMaps` — the #2205
 * PR-A render cut for the terminal lifecycle status readers. Drives the hooks
 * against the in-memory `session-lifecycle` region harness and asserts they source
 * the connect / reconnect / disconnect-error status from a mirroring projected
 * snapshot, fall back to `appStore` when the region does not mirror, and never
 * subscribe when the render cut is off.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useAppStore } from "@/store/appStore";
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
  useAppStore.setState({
    terminalConnecting: {},
    terminalReconnectingTabs: {},
    terminalDisconnectErrors: {},
  });
});

describe("useProjectedSessionLifecycle (per tab)", () => {
  const harness = installSessionLifecycleHarness();

  function Probe({ onValue }: { onValue: (v: ProjectedSessionLifecycleSlice) => void }) {
    onValue(useProjectedSessionLifecycle(TAB));
    return null;
  }

  it("sources connecting from a mirroring projected snapshot", async () => {
    useAppStore.setState({ terminalConnecting: { [TAB]: true } });
    harness.transport.setSession(TAB, connecting());
    let latest: ProjectedSessionLifecycleSlice | undefined;
    mount(<Probe onValue={(v) => (latest = v)} />);
    await flushSessionRegion();

    expect(harness.transport.subscribeCount).toBeGreaterThan(0);
    expect(latest?.connecting).toBe(true);
  });

  it("sources reconnecting and the disconnect error from mirroring snapshots", async () => {
    useAppStore.setState({
      terminalReconnectingTabs: { [TAB]: true },
      terminalDisconnectErrors: {},
    });
    harness.transport.setSession(
      TAB,
      reconnecting({ phase: "waiting", attempt: 1, delayMs: 3000 })
    );
    let latest: ProjectedSessionLifecycleSlice | undefined;
    mount(<Probe onValue={(v) => (latest = v)} />);
    await flushSessionRegion();
    expect(latest?.reconnecting).toBe(true);

    // Now a failed disconnect with a matching error string.
    useAppStore.setState({
      terminalReconnectingTabs: {},
      terminalDisconnectErrors: { [TAB]: "auth failed" },
    });
    act(() => harness.transport.setSession(TAB, failed("auth failed")));
    await flushSessionRegion();
    expect(latest?.disconnectError).toBe("auth failed");
  });

  it("falls back to appStore when the region diverges", async () => {
    // appStore says connecting; region reports connected — the gate rejects it.
    useAppStore.setState({ terminalConnecting: { [TAB]: true } });
    harness.transport.setSession(TAB, connected());
    let latest: ProjectedSessionLifecycleSlice | undefined;
    mount(<Probe onValue={(v) => (latest = v)} />);
    await flushSessionRegion();
    expect(latest?.connecting).toBe(true);
  });
});

describe("useProjectedSessionLifecycle — render cut off", () => {
  const harness = installSessionLifecycleHarness(false);

  function Probe({ onValue }: { onValue: (v: ProjectedSessionLifecycleSlice) => void }) {
    onValue(useProjectedSessionLifecycle(TAB));
    return null;
  }

  it("returns appStore verbatim and never subscribes", async () => {
    useAppStore.setState({ terminalConnecting: { [TAB]: true } });
    // A divergent snapshot exists but must be ignored with the flag off.
    harness.transport.setSession(TAB, connected());
    let latest: ProjectedSessionLifecycleSlice | undefined;
    mount(<Probe onValue={(v) => (latest = v)} />);
    await flushSessionRegion();
    expect(latest?.connecting).toBe(true);
    expect(harness.transport.subscribeCount).toBe(0);
  });
});

describe("useProjectedSessionLifecycleMaps (list consumers)", () => {
  const harness = installSessionLifecycleHarness();

  function Probe({ onValue }: { onValue: (v: ProjectedSessionLifecycleMaps) => void }) {
    onValue(useProjectedSessionLifecycleMaps());
    return null;
  }

  it("mirrors the appStore maps sourced through the region", async () => {
    useAppStore.setState({
      terminalConnecting: { a: true },
      terminalReconnectingTabs: { b: true },
      terminalDisconnectErrors: { c: "boom" },
    });
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
