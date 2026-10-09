/**
 * #4434: `TerminalHost` must not mount a `<Terminal>` (which creates the
 * session) for a tab held on an unconfirmed imported inline config. Once the
 * user confirms it, the terminal mounts and connects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { LeafPanel, TerminalTab } from "@/types/terminal";

vi.mock("./Terminal", () => ({
  Terminal: ({ tabId }: { tabId: string }) => <div data-testid={`term-${tabId}`} />,
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
  getXtermTheme: vi.fn(() => ({})),
}));

import { TerminalHost } from "./TerminalView";
import { seedLayoutState } from "@/test/layoutState";

function termTab(id: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    sessionId: null,
    title: id,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "a",
    isActive: id === "t1",
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TerminalHost with a held imported connection (#4434)", () => {
  it("mounts no terminal for the held tab until it is confirmed", () => {
    const panel: LeafPanel = {
      type: "leaf",
      id: "a",
      activeTabId: "t1",
      tabs: [termTab("t1"), termTab("t2", { pendingImportedConnection: true })],
    };
    act(() => {
      seedLayoutState({
        rootPanel: panel,
        activeTabGroupId: "g1",
        tabGroups: [{ id: "g1", name: "Main", rootPanel: panel, activePanelId: "a" }],
      });
      root.render(<TerminalHost />);
    });
    expect(container.querySelector('[data-testid="term-t1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="term-t2"]')).toBeNull();

    act(() => {
      useAppStore.setState((s) => ({
        tabContent: {
          ...s.tabContent,
          t2: { ...s.tabContent.t2, pendingImportedConnection: undefined },
        },
      }));
    });
    expect(container.querySelector('[data-testid="term-t2"]')).not.toBeNull();
  });
});
