/**
 * `useSessionAutoReconnect` — the auto-reconnect countdown for one tab (#2205,
 * #3992). The region carries the backoff window (`attempt` + `delayMs`) but not a
 * wall-clock deadline; the hook anchors `nextAttemptAt` once per window so the
 * overlay's countdown ticks down instead of restarting on every re-render, and
 * re-anchors only when the loop advances to a new attempt.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalAutoReconnectState } from "@/types/terminal";
import {
  connected,
  flushSessionRegion,
  installSessionLifecycleHarness,
  reconnecting,
} from "@/test/sessionLifecycleRegionTestHarness";

import { useSessionAutoReconnect } from "./useSessionLifecycle";

const TAB = "tab-1";

let root: Root | null = null;
let latest: TerminalAutoReconnectState | undefined;

function Probe({ tick }: { tick: number }) {
  latest = useSessionAutoReconnect(TAB);
  return <i data-tick={tick} />;
}

function mount(): void {
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Probe tick={0} />));
}

/** Re-render with an unrelated prop change and the region unchanged. */
function rerender(tick: number): void {
  act(() => root!.render(<Probe tick={tick} />));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  latest = undefined;
  vi.useRealTimers();
});

describe("useSessionAutoReconnect", () => {
  const harness = installSessionLifecycleHarness();

  it("keeps the countdown deadline across re-renders within one backoff window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000);
    harness.transport.setSession(
      TAB,
      reconnecting({ phase: "waiting", attempt: 1, delayMs: 5000 })
    );
    mount();
    await flushSessionRegion();
    expect(latest).toMatchObject({ phase: "waiting", attempt: 1, nextAttemptAt: 15_000 });

    // Time passes and the component re-renders; the deadline must not move.
    vi.setSystemTime(12_000);
    rerender(1);
    expect(latest?.nextAttemptAt).toBe(15_000);
  });

  it("re-anchors the deadline when the loop advances to a new attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000);
    harness.transport.setSession(
      TAB,
      reconnecting({ phase: "waiting", attempt: 1, delayMs: 5000 })
    );
    mount();
    await flushSessionRegion();

    vi.setSystemTime(16_000);
    act(() =>
      harness.transport.setSession(
        TAB,
        reconnecting({ phase: "waiting", attempt: 2, delayMs: 8000 })
      )
    );
    await flushSessionRegion();
    expect(latest).toMatchObject({ attempt: 2, delayMs: 8000, nextAttemptAt: 24_000 });
  });

  it("is undefined once the session is connected again", async () => {
    harness.transport.setSession(
      TAB,
      reconnecting({ phase: "waiting", attempt: 1, delayMs: 5000 })
    );
    mount();
    await flushSessionRegion();
    expect(latest?.phase).toBe("waiting");

    act(() => harness.transport.setSession(TAB, connected()));
    await flushSessionRegion();
    expect(latest).toBeUndefined();
  });
});
