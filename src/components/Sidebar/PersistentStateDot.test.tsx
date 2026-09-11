import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PersistentStateDot } from "./PersistentStateDot";
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
      root.render(
        <PersistentStateDot
          runState={runState}
          stateDotClass="connection-tree__state-dot--running"
          connectionId="c1"
          dotTestId="dot"
        />
      )
    );
    expect(dot()?.getAttribute("role")).toBe("img");
    expect(dot()?.getAttribute("aria-label")).toBe(label);
  });

  it("labels a never-started (null) session as Stopped", () => {
    act(() =>
      root.render(
        <PersistentStateDot
          runState={null}
          stateDotClass="connection-tree__state-dot--stopped"
          connectionId="c1"
          dotTestId="dot"
        />
      )
    );
    expect(dot()?.getAttribute("aria-label")).toBe("Stopped");
  });
});
