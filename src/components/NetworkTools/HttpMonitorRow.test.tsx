/** The panel's monitor row says where it runs and what is known there (#6039, #6052). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { withTooltip } from "@/test/tooltip";
import type { HttpMonitorState } from "@/types/network";
import { HttpMonitorRow } from "./HttpMonitorRow";

let container: HTMLDivElement;
let root: Root;

const monitor = (over: Partial<HttpMonitorState> = {}): HttpMonitorState => ({
  config: {
    id: "m",
    url: "https://m.example/health",
    intervalMs: 30_000,
    method: "GET",
    expectedStatus: 200,
    timeoutMs: 5_000,
  },
  running: true,
  paused: false,
  ...over,
});

const steps = vi.fn();

function render(
  m: HttpMonitorState,
  runsOn?: string,
  nextSteps: { id: "connectAgent" | "setUpAgain"; label: string }[] = [],
  runs = { pause: !m.paused && m.running, resume: m.paused || !m.running, stop: m.running }
) {
  const noop = vi.fn();
  act(() =>
    root.render(
      withTooltip(
        <HttpMonitorRow
          monitor={m}
          runsOn={runsOn}
          onShow={noop}
          onPause={noop}
          onResume={noop}
          onStop={noop}
          onRemove={noop}
          runs={runs}
          nextSteps={nextSteps}
          onNextStep={steps}
        />
      )
    )
  );
}
const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("HttpMonitorRow", () => {
  it("names the agent it runs on, and its state in the words of a service", () => {
    render(
      monitor({
        status: "running",
        lastResult: { monitorId: "m", ok: true, statusCode: 200, timestampMs: Date.now() },
      }),
      "Edge box"
    );
    expect(container.textContent).toContain("last check HTTP 200");
    expect(container.textContent).toContain("on Edge box");
    expect(text("monitor-state-m")).toBe("Running");
  });

  it("says why it does not check now", () => {
    const why = "Its agent is offline. It may still run there; termiHub cannot tell.";
    render(monitor({ running: false, status: "notReachable", reason: why }), "Edge box");
    expect(text("monitor-state-m")).toBe("Agent offline");
    expect(text("monitor-reason-m")).toBe(why);
  });

  it("a paused one says paused, and one here names no machine", () => {
    render(monitor({ paused: true, status: "running" }));
    expect(text("monitor-state-m")).toBe("Paused");
    expect(container.textContent).toContain("on this computer");
    expect(text("monitor-reason-m")).toBeUndefined();
  });

  it("its actions say what they do, on one line of their own (F-009)", () => {
    render(monitor({ status: "running" }));
    const actions = container.querySelector('[data-testid="monitor-actions-m"]')!;
    const words = [...actions.querySelectorAll("button")].map((b) => b.textContent);
    expect(words).toEqual(["Show checks", "Pause", "Stop", "Delete"]);
  });

  it("offers only what can be done now", () => {
    render(monitor({ status: "stopping" }), "Edge box", [], {
      pause: false,
      resume: false,
      stop: false,
    });
    const words = [...container.querySelectorAll('[data-testid="monitor-actions-m"] button')].map(
      (b) => b.textContent
    );
    expect(words).toEqual(["Show checks", "Delete"]);
  });

  it("a reason comes with its next step", () => {
    const why = "Not started: termiHub cannot read where it runs.";
    render(monitor({ running: false, status: "error", reason: why }), undefined, [
      { id: "setUpAgain", label: "Set it up again" },
    ]);
    const step = container.querySelector<HTMLButtonElement>(
      '[data-testid="monitor-step-setUpAgain-m"]'
    )!;
    expect(step.textContent).toBe("Set it up again");
    act(() => step.click());
    expect(steps).toHaveBeenCalledWith("setUpAgain", "m");
  });

  it("a failing one reads Down, with the last check as its reason (F-009 round 2)", () => {
    render(
      monitor({
        status: "running",
        lastResult: { monitorId: "m", ok: false, statusCode: 503, timestampMs: Date.now() },
      })
    );
    expect(text("monitor-state-m")).toBe("Down");
    expect(text("monitor-reason-m")).toBe("Last check HTTP 503, expected 200, just now");
    // Said once: not again in the meta line.
    expect(container.textContent!.split("HTTP 503")).toHaveLength(2);
  });

  it("one whose machine cannot be read says so where the machine would be", () => {
    act(() =>
      root.render(
        withTooltip(
          <HttpMonitorRow
            monitor={monitor({ status: "error", running: false })}
            whereUnknown
            runs={{ pause: false, resume: false, stop: false }}
            nextSteps={[]}
            onNextStep={vi.fn()}
            onShow={vi.fn()}
            onPause={vi.fn()}
            onResume={vi.fn()}
            onStop={vi.fn()}
            onRemove={vi.fn()}
          />
        )
      )
    );
    expect(container.textContent).toContain("where it runs is unknown");
    expect(text("monitor-state-m")).toBe("Not started");
  });
});
