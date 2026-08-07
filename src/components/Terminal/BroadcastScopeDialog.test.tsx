/**
 * Tests for the broadcast scope-selection dialog (#1956): scope options with
 * live counts, the custom per-terminal picker (non-terminal exclusion, Select
 * All / Select None), and that confirming starts broadcast with the resolved
 * target set and remembered scope.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

import { BroadcastScopeDialog } from "./BroadcastScopeDialog";
import { useAppStore } from "@/store/appStore";
import { currentBroadcastView, ensureBroadcastSubscribed } from "@/store/broadcastBridge";
import { installBroadcastHarness } from "@/test/broadcastHarness";
import type {
  LeafPanel,
  TerminalTab,
  TabContentType,
  ConnectionType,
  BroadcastScope,
} from "@/types/terminal";

let container: HTMLDivElement;
let root: Root;
let harness: ReturnType<typeof installBroadcastHarness>;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function makeTab(
  id: string,
  contentType: TabContentType = "terminal",
  connectionType: ConnectionType = "local"
): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: id,
    connectionType,
    contentType,
    config: { type: "local", config: {} },
    panelId: "leaf-1",
    isActive: id === "src",
  };
}

function seed(tabs: TerminalTab[], scope: BroadcastScope = "all") {
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs, activeTabId: "src" };
  useAppStore.setState({ rootPanel: leaf, activePanelId: "leaf-1" });
  // The remembered scope lives in the authoritative broadcast region (#2206).
  harness.transport.seed({ lastScope: scope });
}

const q = (sel: string) => document.querySelector(sel);
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

describe("BroadcastScopeDialog (#1956)", () => {
  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    harness = installBroadcastHarness();
    await ensureBroadcastSubscribed();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    harness.teardown();
    vi.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    seed([makeTab("src")]);
    render(<BroadcastScopeDialog open={false} onOpenChange={() => {}} sourceTabId="src" />);
    expect(q('[data-testid="broadcast-scope-select"]')).toBeNull();
  });

  it("renders the scope select when open", () => {
    seed([makeTab("src"), makeTab("t2")]);
    render(<BroadcastScopeDialog open onOpenChange={() => {}} sourceTabId="src" />);
    expect(q(".ui-modal")).toBeTruthy();
    expect(q('[data-testid="broadcast-scope-select"]')).toBeTruthy();
  });

  it("Start with the 'all' scope broadcasts to every terminal plus the source", () => {
    seed([makeTab("src"), makeTab("t2"), makeTab("editor", "editor")], "all");
    render(<BroadcastScopeDialog open onOpenChange={() => {}} sourceTabId="src" />);

    click(q('[data-testid="broadcast-scope-confirm"]'));

    const v = currentBroadcastView();
    expect(v.active).toBe(true);
    expect(v.scope).toBe("all");
    expect(v.lastScope).toBe("all");
    // Non-terminal "editor" tab is excluded.
    expect([...v.targetTabIds].sort()).toEqual(["src", "t2"]);
  });

  it("custom picker lists only terminal tabs, never non-terminal ones", () => {
    seed([makeTab("src"), makeTab("t2"), makeTab("editor", "editor")], "custom");
    render(<BroadcastScopeDialog open onOpenChange={() => {}} sourceTabId="src" />);

    expect(q('[data-testid="broadcast-target-src"]')).toBeTruthy();
    expect(q('[data-testid="broadcast-target-t2"]')).toBeTruthy();
    expect(q('[data-testid="broadcast-target-editor"]')).toBeNull();
  });

  it("Select None disables Start; Select All re-enables it", () => {
    seed([makeTab("src"), makeTab("t2")], "custom");
    render(<BroadcastScopeDialog open onOpenChange={() => {}} sourceTabId="src" />);

    const confirm = () => q('[data-testid="broadcast-scope-confirm"]') as HTMLButtonElement;
    // Pre-selected → actionable.
    expect(confirm().disabled).toBe(false);

    click(q('[data-testid="broadcast-scope-select-none"]'));
    expect(confirm().disabled).toBe(true);

    click(q('[data-testid="broadcast-scope-select-all"]'));
    expect(confirm().disabled).toBe(false);
  });

  it("custom Start broadcasts to exactly the checked terminals", () => {
    seed([makeTab("src"), makeTab("t2"), makeTab("t3")], "custom");
    render(<BroadcastScopeDialog open onOpenChange={() => {}} sourceTabId="src" />);

    // Uncheck t3 (starts fully selected).
    click(q('[data-testid="broadcast-target-t3"]'));
    click(q('[data-testid="broadcast-scope-confirm"]'));

    const v = currentBroadcastView();
    expect(v.active).toBe(true);
    expect(v.scope).toBe("custom");
    expect([...v.targetTabIds].sort()).toEqual(["src", "t2"]);
  });

  it("Cancel closes without starting broadcast", () => {
    seed([makeTab("src"), makeTab("t2")]);
    const onOpenChange = vi.fn();
    render(<BroadcastScopeDialog open onOpenChange={onOpenChange} sourceTabId="src" />);

    click(q('[data-testid="broadcast-scope-cancel"]'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(currentBroadcastView().active).toBe(false);
  });
});
