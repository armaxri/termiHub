import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ConnectProgress, type ConnectStage } from "./ConnectProgress";
import { mockReducedMotion, type ReducedMotionMock } from "@/test/reducedMotion";

let container: HTMLDivElement;
let root: Root;
let motion: ReducedMotionMock;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

const STAGES: ConnectStage[] = [
  { id: "resolve", label: "Resolve", state: "done" },
  { id: "connect", label: "Connect", state: "active" },
  { id: "session", label: "Session", state: "pending" },
];

const T0 = 1_700_000_000_000;

function base(overrides: Partial<React.ComponentProps<typeof ConnectProgress>> = {}) {
  return (
    <ConnectProgress
      phase="connecting"
      target="192.168.0.42"
      typeLabel="Telnet"
      typeIcon={<span data-testid="type-icon" />}
      details={["port 23"]}
      stages={STAGES}
      status="TCP handshake with 192.168.0.42:23"
      startedAt={T0}
      deadlineAt={T0 + 90_000}
      now={T0 + 4_000}
      actions={<button type="button">Abort</button>}
      {...overrides}
    />
  );
}

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;

describe("ConnectProgress", () => {
  beforeEach(() => {
    motion = mockReducedMotion(false);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    motion.restore();
    vi.useRealTimers();
  });

  it("names the target and the connection type", () => {
    render(base());
    expect(q(".ui-content-overlay__heading")?.textContent).toBe("Connecting to 192.168.0.42");
    expect(container.textContent).toContain("Telnet");
    expect(container.textContent).toContain("port 23");
  });

  it("renders one step per stage with its state", () => {
    render(base());
    const steps = container.querySelectorAll<HTMLElement>(".ui-connect-progress__step");
    expect(Array.from(steps).map((s) => s.dataset.state)).toEqual(["done", "active", "pending"]);
    expect(steps[1].getAttribute("aria-current")).toBe("step");
  });

  it("shows elapsed and remaining time from one clock", () => {
    render(base());
    expect(q("[data-testid=connect-progress-time]")?.textContent).toBe(
      "4s elapsed · times out in 86s"
    );
  });

  it("drives the ring from CSS (negative delay = elapsed) so it never waits on a JS timer", () => {
    render(base());
    const ring = q(".ui-connect-progress__ring") as HTMLElement;
    expect(ring.style.getPropertyValue("--cp-duration")).toBe("90000ms");
    expect(ring.style.getPropertyValue("--cp-delay")).toBe("-4000ms");
    // The static fallback (reduced motion) matches the same instant.
    expect(ring.style.getPropertyValue("--cp-progress")).toBe(String(4 / 90));
  });

  it("is indeterminate when there is no deadline", () => {
    render(base({ deadlineAt: undefined }));
    expect(q(".ui-connect-progress__ring--indeterminate")).not.toBeNull();
    expect(q("[data-testid=connect-progress-time]")?.textContent).toBe("4s elapsed");
  });

  it("keeps the comet (liveness cue) only with full motion", () => {
    render(base());
    expect(q(".ui-connect-progress__comet")).not.toBeNull();
    act(() => motion.set(true));
    expect(q(".ui-connect-progress__comet")).toBeNull();
  });

  it("ticks the readout while connecting when no fixed clock is given", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    render(base({ now: undefined }));
    expect(q("[data-testid=connect-progress-time]")?.textContent).toContain("0s elapsed");
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(q("[data-testid=connect-progress-time]")?.textContent).toContain("3s elapsed");
  });

  it("shows the retry attempt and next-try countdown", () => {
    render(base({ phase: "retrying", attempt: { current: 2, max: 5, nextInSeconds: 3 } }));
    expect(q(".ui-content-overlay__heading")?.textContent).toBe("Reconnecting to 192.168.0.42");
    expect(container.textContent).toContain("Attempt 2 of 5 · next try in 3s");
  });

  it.each([
    ["failed", "Connection failed"],
    ["timeout", "Timed out"],
    ["aborted", "Connection aborted"],
  ] as const)("renders the %s resting state with its error body", (phase, heading) => {
    render(base({ phase, error: <span data-testid="err">boom</span> }));
    expect(q(".ui-content-overlay__heading")?.textContent).toBe(heading);
    expect(q("[data-testid=err]")).not.toBeNull();
    expect(q(".ui-connect-progress__ring")).toBeNull();
    expect(q(".ui-connect-progress")?.dataset.phase).toBe(phase);
    expect(q("[aria-busy=true]")).toBeNull();
  });

  it("marks the busy phases aria-busy", () => {
    render(base());
    expect(q("[aria-busy=true]")).not.toBeNull();
  });
});
