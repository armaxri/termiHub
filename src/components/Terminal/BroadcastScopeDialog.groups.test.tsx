/**
 * Tests for persistent named broadcast groups in the scope dialog (PROD-061,
 * #3443): saved groups appear as scopes with their open count, starting one
 * broadcasts to exactly the open terminals of its saved connections (frozen,
 * `custom` membership), the dialog says which members are not open, and the
 * custom picker can save its selection as a group.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
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
import { currentSettingsView } from "@/store/settingsBridge";
import { saveSettings } from "@/services/storage";
import { installBroadcastHarness } from "@/test/broadcastHarness";
import { seedLayoutState } from "@/test/layoutState";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { BroadcastScope, LeafPanel, TerminalTab } from "@/types/terminal";

setupSettingsRegion();

let container: HTMLDivElement;
let root: Root;
let harness: ReturnType<typeof installBroadcastHarness>;

function term(id: string, connectionId?: string): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `host-${id}`,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: "leaf-1",
    isActive: id === "src",
    connectionId,
  };
}

function seed(tabs: TerminalTab[], scope: BroadcastScope = "all") {
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs, activeTabId: "src" };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
  harness.transport.seed({ lastScope: scope });
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

function pickScope(label: string) {
  const trigger = q('[data-testid="broadcast-scope-select"]') as HTMLButtonElement;
  act(() => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
    o.textContent?.includes(label)
  ) as HTMLElement | undefined;
  expect(option).toBeTruthy();
  act(() => {
    option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function render() {
  act(() => {
    root.render(<BroadcastScopeDialog open onOpenChange={() => {}} sourceTabId="src" />);
  });
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("BroadcastScopeDialog — named groups (PROD-061)", () => {
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

  it("lists saved groups with the number of open member terminals", () => {
    seed([term("src", "c0"), term("a", "c1"), term("b", "c2")]);
    seedSettings({ broadcastGroups: [{ id: "g1", name: "web", connectionIds: ["c1", "c2"] }] });
    render();
    pickScope('Group "web"');
    expect(q('[data-testid="broadcast-scope-select"]')?.textContent).toContain(
      'Group "web" (2 open)'
    );
    // Opening the scope picker with Enter must not also start broadcasting.
    expect(currentBroadcastView().active).toBe(false);
  });

  it("starts a frozen broadcast to exactly the group's open terminals plus the source", () => {
    seed([term("src", "c1"), term("a", "c2"), term("b", "c3"), term("adhoc")]);
    seedSettings({
      broadcastGroups: [{ id: "g1", name: "web", connectionIds: ["c1", "c2", "c9"] }],
    });
    render();
    pickScope('Group "web"');

    const members = q('[data-testid="broadcast-group-members"]');
    expect(members?.textContent).toContain("host-src");
    expect(members?.textContent).toContain("host-a");
    expect(members?.textContent).not.toContain("host-b");
    expect(q('[data-testid="broadcast-group-summary"]')?.textContent).toContain(
      "1 saved connection is not open"
    );
    const start = q('[data-testid="broadcast-scope-confirm"]');
    expect(start?.textContent).toBe("Start Broadcast (2)");
    click(start);

    const v = currentBroadcastView();
    expect(v.active).toBe(true);
    expect(v.scope).toBe("custom");
    expect([...v.targetTabIds].sort()).toEqual(["a", "src"]);
  });

  it("warns when the source terminal is not a member of the group", () => {
    seed([term("src", "c0"), term("a", "c1")]);
    seedSettings({ broadcastGroups: [{ id: "g1", name: "web", connectionIds: ["c1"] }] });
    render();
    pickScope('Group "web"');
    expect(q('[data-testid="broadcast-group-summary"]')?.textContent).toContain(
      'You type in "host-src", which is not in this group'
    );
  });

  it("saves the custom selection as a named group without starting a broadcast", async () => {
    seed([term("src", "c1"), term("a", "c2"), term("adhoc")], "custom");
    render();

    expect(q('[data-testid="broadcast-group-save"]')?.textContent).toContain(
      "1 selected terminal isn't a saved connection"
    );
    setInput(q('[data-testid="broadcast-group-name"]') as HTMLInputElement, "  web  ");
    // Enter in the name field saves; it must never start the broadcast.
    await act(async () => {
      q('[data-testid="broadcast-group-name"]')?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(currentBroadcastView().active).toBe(false);
    expect(saveSettings).toHaveBeenCalled();
    const groups = currentSettingsView().broadcastGroups ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("web");
    expect(groups[0].connectionIds).toEqual(["c1", "c2"]);
  });

  it("rejects an empty group name inline", async () => {
    seed([term("src", "c1")], "custom");
    render();
    await act(async () => {
      q('[data-testid="broadcast-group-save-button"]')?.click();
      await Promise.resolve();
    });
    expect(q('[data-testid="broadcast-group-save"]')?.textContent).toContain("Enter a group name");
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("disables saving when no selected terminal is a saved connection", () => {
    seed([term("src"), term("a")], "custom");
    render();
    expect((q('[data-testid="broadcast-group-save-button"]') as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("deletes a saved group", async () => {
    seed([term("src", "c1")]);
    seedSettings({ broadcastGroups: [{ id: "g1", name: "web", connectionIds: ["c1"] }] });
    render();
    pickScope('Group "web"');
    await act(async () => {
      q('[data-testid="broadcast-group-delete"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentSettingsView().broadcastGroups).toEqual([]);
  });

  it("never falls back to a broader scope when the selected group disappears", () => {
    seed([term("src", "c1"), term("a", "c2")]);
    seedSettings({ broadcastGroups: [{ id: "g1", name: "web", connectionIds: ["c2"] }] });
    render();
    pickScope('Group "web"');
    // Another window deletes the group while this dialog is open.
    act(() => seedSettings({ broadcastGroups: [] }));
    const start = q('[data-testid="broadcast-scope-confirm"]') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    click(start);
    expect(currentBroadcastView().active).toBe(false);
  });
});
