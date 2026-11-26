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

function render(m: HttpMonitorState, runsOn?: string) {
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
    render(monitor({ status: "running" }), "Edge box");
    expect(container.textContent).toContain("on Edge box");
    expect(text("monitor-state-m")).toBe("running");
  });

  it("says why it does not check now", () => {
    const why = "Its agent is offline. It may still run there; termiHub cannot tell.";
    render(monitor({ running: false, status: "notReachable", reason: why }), "Edge box");
    expect(text("monitor-state-m")).toBe("not reachable");
    expect(text("monitor-reason-m")).toBe(why);
  });

  it("a paused one says paused, and one here names no machine", () => {
    render(monitor({ paused: true, status: "running" }));
    expect(text("monitor-state-m")).toBe("paused");
    expect(container.textContent).not.toContain(" on ");
    expect(text("monitor-reason-m")).toBeUndefined();
  });
});
