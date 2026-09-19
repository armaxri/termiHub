import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PersistentStateDot, persistentRunStateDotStyle } from "./PersistentStateDot";
import { useAppStore } from "@/store/appStore";
import type { PersistentRunState } from "@/types/connection";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // No attached sessions → the plain dot (no count badge) path.
  useAppStore.setState({ persistentSessions: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function dot(): HTMLElement | null {
  return container.querySelector('[data-testid="dot"]');
}

describe("PersistentStateDot — non-colour accessible name (A11Y-004)", () => {
  it.each([
    ["stopped", "Stopped"],
    ["starting", "Starting"],
    ["running", "Running"],
    ["attached", "Attached"],
    ["stopping", "Stopping"],
    ["error", "Error"],
  ] as [PersistentRunState, string][])("labels the %s run-state as %s", (runState, label) => {
    act(() =>
      root.render(<PersistentStateDot runState={runState} connectionId="c1" dotTestId="dot" />)
    );
    expect(dot()?.getAttribute("role")).toBe("img");
    expect(dot()?.getAttribute("aria-label")).toBe(label);
  });

  it("labels a never-started (null) session as Stopped", () => {
    act(() =>
      root.render(<PersistentStateDot runState={null} connectionId="c1" dotTestId="dot" />)
    );
    expect(dot()?.getAttribute("aria-label")).toBe("Stopped");
  });
});

describe("PersistentStateDot — renders via the shared StatusDot (UISF-003)", () => {
  it("renders the shared status-dot primitive at the small size", () => {
    act(() =>
      root.render(<PersistentStateDot runState="running" connectionId="c1" dotTestId="dot" />)
    );
    const cls = dot()?.className ?? "";
    expect(cls).toContain("status-dot");
    expect(cls).toContain("status-dot--sm");
    // No bespoke connection-tree dot class remains.
    expect(cls).not.toContain("connection-tree__state-dot");
  });

  it.each([
    ["running", "status-dot--connected"],
    ["attached", "status-dot--connected"],
    ["starting", "status-dot--connecting"],
    ["stopping", "status-dot--connecting"],
    ["error", "status-dot--error"],
    ["stopped", "status-dot--neutral"],
  ] as [PersistentRunState, string][])("maps the %s run-state to %s", (runState, toneClass) => {
    act(() =>
      root.render(<PersistentStateDot runState={runState} connectionId="c1" dotTestId="dot" />)
    );
    expect(dot()?.className).toContain(toneClass);
  });

  it("pulses only while transitioning and dims only when stopped", () => {
    act(() =>
      root.render(<PersistentStateDot runState="starting" connectionId="c1" dotTestId="dot" />)
    );
    expect(dot()?.className).toContain("status-dot--pulse");

    act(() =>
      root.render(<PersistentStateDot runState={null} connectionId="c1" dotTestId="dot" />)
    );
    expect(dot()?.className).toContain("status-dot--dimmed");
    expect(dot()?.className).not.toContain("status-dot--pulse");
  });
});

describe("persistentRunStateDotStyle", () => {
  it("maps each run-state to the correct tone/pulse/dimmed", () => {
    expect(persistentRunStateDotStyle("running")).toEqual({
      tone: "connected",
      pulse: false,
      dimmed: false,
    });
    expect(persistentRunStateDotStyle("attached")).toEqual({
      tone: "connected",
      pulse: false,
      dimmed: false,
    });
    expect(persistentRunStateDotStyle("starting")).toEqual({
      tone: "connecting",
      pulse: true,
      dimmed: false,
    });
    expect(persistentRunStateDotStyle("stopping")).toEqual({
      tone: "connecting",
      pulse: true,
      dimmed: false,
    });
    expect(persistentRunStateDotStyle("error")).toEqual({
      tone: "error",
      pulse: false,
      dimmed: false,
    });
    expect(persistentRunStateDotStyle("stopped")).toEqual({
      tone: "neutral",
      pulse: false,
      dimmed: true,
    });
    expect(persistentRunStateDotStyle(null)).toEqual({
      tone: "neutral",
      pulse: false,
      dimmed: true,
    });
  });
});
