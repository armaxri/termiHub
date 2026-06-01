import { describe, it, expect } from "vitest";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import { getPanelActiveSessionId } from "./panelTree";

/**
 * Regression tests for per-pane OS file drop routing.
 *
 * REGRESSION: Before the fix, the OS file-drop listener was attached once to the
 * entire terminal content area and always sent the dropped path to the globally
 * active tab (getActiveTab). When the view was split into several panes, the whole
 * area acted as a single drop zone, so dropping a file onto a non-active pane still
 * inserted the path into the active pane's session.
 *
 * The fix scopes dropping to each leaf panel. getPanelActiveSessionId resolves the
 * session of the tab currently shown in a given panel, so each pane routes the drop
 * to its OWN session regardless of which pane is globally active.
 */

function makeTab(overrides: Partial<TerminalTab> & { id: string }): TerminalTab {
  return {
    sessionId: null,
    title: overrides.id,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "panel-1",
    isActive: false,
    ...overrides,
  };
}

function makeLeaf(tabs: TerminalTab[], activeTabId: string | null): LeafPanel {
  return { type: "leaf", id: "panel-1", tabs, activeTabId };
}

describe("getPanelActiveSessionId — per-pane file drop routing", () => {
  it("returns the session of the panel's active terminal tab", () => {
    const panel = makeLeaf(
      [makeTab({ id: "a", sessionId: "sess-a" }), makeTab({ id: "b", sessionId: "sess-b" })],
      "b"
    );
    expect(getPanelActiveSessionId(panel)).toBe("sess-b");
  });

  it("resolves each panel to its own session (not a shared active tab)", () => {
    const left = makeLeaf([makeTab({ id: "a", sessionId: "sess-a" })], "a");
    const right = makeLeaf([makeTab({ id: "b", sessionId: "sess-b" })], "b");
    expect(getPanelActiveSessionId(left)).toBe("sess-a");
    expect(getPanelActiveSessionId(right)).toBe("sess-b");
  });

  it("returns null when the active tab has no session yet (still connecting)", () => {
    const panel = makeLeaf([makeTab({ id: "a", sessionId: null })], "a");
    expect(getPanelActiveSessionId(panel)).toBeNull();
  });

  it("returns null when the active tab is not a terminal", () => {
    const panel = makeLeaf(
      [makeTab({ id: "a", sessionId: "sess-a", contentType: "settings" })],
      "a"
    );
    expect(getPanelActiveSessionId(panel)).toBeNull();
  });

  it("returns null for an empty panel", () => {
    expect(getPanelActiveSessionId(makeLeaf([], null))).toBeNull();
  });

  it("returns null when activeTabId points to a missing tab", () => {
    const panel = makeLeaf([makeTab({ id: "a", sessionId: "sess-a" })], "gone");
    expect(getPanelActiveSessionId(panel)).toBeNull();
  });
});
