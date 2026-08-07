/**
 * Tests for the keyboard-shortcut broadcast toggle (#1958).
 *
 * Covers `toggleBroadcast`: starting broadcast against the active terminal with
 * the remembered scope (skipping the dropdown), stopping on a second press
 * regardless of focus, the "custom" → "all" fallback, and the no-terminal hint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The store pulls in the full service graph on import; stub the modules with
// side effects at load time (mirrors the sibling broadcast-slice suite).
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

import { useAppStore } from "./appStore";
import { currentBroadcastView, ensureBroadcastSubscribed } from "./broadcastBridge";
import { installBroadcastHarness } from "@/test/broadcastHarness";
import { toast } from "@/components/ui";
import type { LeafPanel, TerminalTab, TabContentType } from "@/types/terminal";

// Spy on the real toast (avoids mocking the whole UI barrel, which the store's
// import graph also pulls from) to assert the no-terminal hint fires.
const toastInfo = vi.spyOn(toast, "info").mockImplementation(() => "");

interface SeedTab {
  id: string;
  contentType?: TabContentType;
  sessionId?: string | null;
}

function makeTab({ id, contentType = "terminal", sessionId = `sess-${id}` }: SeedTab): TerminalTab {
  return {
    id,
    sessionId,
    title: id,
    connectionType: "local",
    contentType,
    config: { type: "local", config: {} },
    panelId: "leaf-1",
    isActive: id === "src",
  };
}

/** Seed one leaf panel holding the given tabs; the first tab is active. */
function seedTabs(tabs: TerminalTab[], activeTabId = tabs[0]?.id ?? null) {
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs, activeTabId };
  useAppStore.setState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

describe("appStore — toggleBroadcast (#1958, region-authoritative #2206)", () => {
  let harness: ReturnType<typeof installBroadcastHarness>;

  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState());
    harness = installBroadcastHarness();
    await ensureBroadcastSubscribed();
    toastInfo.mockClear();
  });

  afterEach(() => {
    harness.teardown();
  });

  it("starts broadcast against the active terminal using the default 'all' scope", () => {
    seedTabs([makeTab({ id: "src" }), makeTab({ id: "t2" }), makeTab({ id: "t3" })]);

    useAppStore.getState().toggleBroadcast();

    const v = currentBroadcastView();
    expect(v.active).toBe(true);
    expect(v.sourceTabId).toBe("src");
    expect(v.scope).toBe("all");
    // All terminals in the group become targets (source included).
    expect([...v.targetTabIds].sort()).toEqual(["src", "t2", "t3"]);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("reuses the last scope, skipping the dropdown", () => {
    seedTabs([makeTab({ id: "src" }), makeTab({ id: "t2" })]);
    // A previous session left the scope as "panel".
    useAppStore.getState().startBroadcast("panel", "src", ["src"]);
    useAppStore.getState().stopBroadcast();
    expect(currentBroadcastView().lastScope).toBe("panel");

    useAppStore.getState().toggleBroadcast();

    expect(currentBroadcastView().active).toBe(true);
    expect(currentBroadcastView().scope).toBe("panel");
  });

  it("stops broadcast on a second press, regardless of focus", () => {
    seedTabs([makeTab({ id: "src" }), makeTab({ id: "t2" })]);
    useAppStore.getState().toggleBroadcast();
    expect(currentBroadcastView().active).toBe(true);

    // Move focus to a non-terminal tab — stopping must still work.
    seedTabs([makeTab({ id: "src" }), makeTab({ id: "editor", contentType: "editor" })], "editor");
    useAppStore.getState().toggleBroadcast();

    const v = currentBroadcastView();
    expect(v.active).toBe(false);
    expect(v.sourceTabId).toBeNull();
    expect(v.targetTabIds).toHaveLength(0);
  });

  it("falls back to 'all' when the remembered scope is 'custom'", () => {
    seedTabs([makeTab({ id: "src" }), makeTab({ id: "t2" })]);
    // Custom selection can only be built via the picker, so the shortcut cannot
    // reconstruct it — it must degrade to "all".
    useAppStore.getState().startBroadcast("custom", "src", ["src"]);
    useAppStore.getState().stopBroadcast();
    expect(currentBroadcastView().lastScope).toBe("custom");

    useAppStore.getState().toggleBroadcast();

    const v = currentBroadcastView();
    expect(v.active).toBe(true);
    expect(v.scope).toBe("all");
    expect([...v.targetTabIds].sort()).toEqual(["src", "t2"]);
  });

  it("does nothing but hint when the active tab is not a terminal", () => {
    seedTabs([makeTab({ id: "editor", contentType: "editor" })]);

    useAppStore.getState().toggleBroadcast();

    expect(currentBroadcastView().active).toBe(false);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });
});
