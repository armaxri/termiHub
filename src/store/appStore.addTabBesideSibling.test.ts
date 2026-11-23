/**
 * A duplicate session of one saved connection opens beside its sibling
 * (#5827). The product-run UI review saw the two tabs of one connection apart
 * in the strip, with only a cut-off "(2)" to tell them apart. `addTab` with
 * `besideSibling` moves the new tab after the last tab of the same connection
 * in its panel, through the granular `layout.reorderTabs` intent, so the
 * authoritative region agrees.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushMacrotask } from "@/test/flushAsync";

import type { PanelNode, TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";
import { FakeLayoutTransport, installLayoutHarness } from "@/test/layoutRegionTestHarness";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

import { useAppStore } from "./appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { buildLayoutSnapshot, ensureLayoutRegionClient, reseedLayoutRegion } from "./layoutBridge";

const SSH = { type: "ssh", config: { host: "h", username: "u" } } as TerminalTab["config"];

function tab(id: string, connectionId?: string): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: connectionId ? `conn ${connectionId}` : `Tab ${id}`,
    connectionType: "ssh",
    contentType: "terminal",
    config: SSH,
    panelId: "a",
    isActive: id === "t1",
    ...(connectionId ? { connectionId } : {}),
  };
}

function leafTree(tabs: TerminalTab[]): PanelNode {
  return { type: "leaf", id: "a", tabs, activeTabId: "t1" };
}

async function flush(): Promise<void> {
  await flushMacrotask();
  await flushMacrotask();
}

function tabContentOf(tabs: TerminalTab[]) {
  return Object.fromEntries(
    tabs.map(({ panelId: _p, isActive: _a, ...content }) => [content.id, content])
  );
}

async function seed(tabs: TerminalTab[]): Promise<void> {
  const root = leafTree(tabs);
  useAppStore.setState(useAppStore.getInitialState());
  seedLayoutState({ rootPanel: root, activePanelId: "a", tabContent: tabContentOf(tabs) });
  const s = layoutState();
  reseedLayoutRegion(buildLayoutSnapshot(s.tabGroups, s.activeTabGroupId, root, "a"));
  await flush();
}

const order = () => getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs.map((t) => t.id));
const regionOrder = (transport: FakeLayoutTransport) => {
  const view = transport.regionView();
  const g = view.groups.find((x) => x.id === view.activeGroupId) ?? view.groups[0];
  return getAllLeaves(g.root as PanelNode).flatMap((l) => l.tabs.map((t) => t.id));
};

let transport: FakeLayoutTransport;
let teardown: () => void;

beforeEach(async () => {
  ({ transport, teardown } = installLayoutHarness());
  await ensureLayoutRegionClient();
});

afterEach(() => teardown());

function addDuplicate(connectionId: string, besideSibling = true): string {
  return useAppStore.getState().addTab(`conn ${connectionId}`, "ssh", SSH, {
    panelId: "a",
    connectionId,
    besideSibling,
  });
}

describe("addTab besideSibling (#5827)", () => {
  it("opens a second session of a connection right after the first", async () => {
    await seed([tab("t1", "web"), tab("t2", "db"), tab("t3")]);
    const id = addDuplicate("web");
    expect(order()).toEqual(["t1", id, "t2", "t3"]);
    await flush();
    expect(regionOrder(transport)).toEqual(["t1", id, "t2", "t3"]);
    expect(order()).toEqual(["t1", id, "t2", "t3"]);
    expect(transport.kinds()).toContain("layout.reorderTabs");
  });

  it("follows the last of several sessions of the connection", async () => {
    await seed([tab("t1", "web"), tab("t2", "db"), tab("t3", "web"), tab("t4")]);
    const id = addDuplicate("web");
    await flush();
    expect(order()).toEqual(["t1", "t2", "t3", id, "t4"]);
  });

  it("stays at the end when no sibling is open or it already follows it", async () => {
    await seed([tab("t1", "db"), tab("t2", "web")]);
    transport.dispatched.length = 0;
    const dup = addDuplicate("web");
    const fresh = addDuplicate("cache");
    await flush();
    expect(order()).toEqual(["t1", "t2", dup, fresh]);
    // `dup` already followed `t2` and `fresh` has no sibling: nothing moved.
    expect(transport.kinds()).not.toContain("layout.reorderTabs");
  });

  it("keeps the new tab active after moving it", async () => {
    await seed([tab("t1", "web"), tab("t2")]);
    const id = addDuplicate("web");
    await flush();
    const leaf = getAllLeaves(layoutState().rootPanel)[0];
    expect(leaf.activeTabId).toBe(id);
  });

  it("appends at the end without the option (workspace and session restore)", async () => {
    await seed([tab("t1", "web"), tab("t2")]);
    const id = addDuplicate("web", false);
    await flush();
    expect(order()).toEqual(["t1", "t2", id]);
  });
});
