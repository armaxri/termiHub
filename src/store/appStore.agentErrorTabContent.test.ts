/**
 * agent-error tabs in the by-id `tabContent` map (#2539, folded into #2283 slice
 * D').
 *
 * Slice C brought every tab type into `appStore.tabContent` **except**
 * `agent-error` — those still rendered via the in-tree fallback. #2539 closes that
 * gap: agent-error tabs are tracked in the map at their creation site (workspace
 * restore) and every content mutation is instrumented — most notably the in-place
 * `agent-error → terminal` conversion after reconnect — so a tracked entry is
 * never stale. This pins that: the map holds a content-identical entry for an
 * agent-error tab, the conversion updates it in sync with the tree, and close
 * prunes it, with render parity throughout.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() } };
});

import type { ConnectionConfig, PanelNode, TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";
import { extractTabContent, useAppStore } from "./appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { __emitAgentsViewForTest, EMPTY_AGENTS_VIEW } from "./agentsBridge";

function agentErrorTab(id: string): TerminalTab {
  return {
    id,
    sessionId: null,
    title: "Def (error)",
    connectionType: "remote-session",
    contentType: "agent-error",
    config: {} as ConnectionConfig,
    panelId: "a",
    isActive: true,
    agentErrorMeta: {
      agentId: "ag1",
      agentName: "Agent 1",
      definitionId: "def1",
      definitionName: "Def",
      error: "agent offline",
      initialCommand: "echo hi",
    },
  } as TerminalTab;
}

/** Install a single-group layout holding one agent-error tab, with the map
 * populated exactly as workspace restore now does (#2539). */
function seedAgentErrorLayout(): void {
  const tab = agentErrorTab("ae1");
  const root: PanelNode = { type: "leaf", id: "a", tabs: [tab], activeTabId: "ae1" };
  useAppStore.setState(useAppStore.getInitialState());
  seedLayoutState({
    rootPanel: root,
    activePanelId: "a",
    tabGroups: [{ id: "g1", name: "Main", rootPanel: root, activePanelId: "a" }],
    activeTabGroupId: "g1",
    tabContent: { ae1: extractTabContent(tab) },
  });
}

describe("appStore — agent-error tabs tracked in tabContent (#2539)", () => {
  beforeEach(() => {
    __emitAgentsViewForTest(EMPTY_AGENTS_VIEW, 0);
  });

  it("an agent-error tab resolves its content from the map (comprehensive)", () => {
    seedAgentErrorLayout();
    const { rootPanel, tabContent } = layoutState();
    const tab = getAllLeaves(rootPanel)[0].tabs[0];
    // The map holds a content-identical entry, carrying the agentErrorMeta.
    expect(tabContent["ae1"]).toEqual(extractTabContent(tab));
    expect(tabContent["ae1"].contentType).toBe("agent-error");
    expect(
      (tabContent["ae1"] as { agentErrorMeta?: { agentId: string } }).agentErrorMeta?.agentId
    ).toBe("ag1");
  });

  it("the agent-error → terminal conversion updates the map in sync with the tree", () => {
    seedAgentErrorLayout();
    // Seed the agent definition so the error tab resolves to a live terminal.
    __emitAgentsViewForTest(
      {
        ...EMPTY_AGENTS_VIEW,
        agentDefinitions: {
          ag1: [
            {
              id: "def1",
              name: "Def",
              sessionType: "local",
              config: { shell: "zsh" },
              persistent: false,
              folderId: null,
            },
          ],
        },
      },
      1
    );

    useAppStore.getState().resolveAgentErrorTabs("ag1");

    const { rootPanel, tabContent } = layoutState();
    const tab = getAllLeaves(rootPanel)[0].tabs[0];
    // Tree converted in place (same tab id — no remount).
    expect(tab.id).toBe("ae1");
    expect(tab.contentType).toBe("terminal");
    expect(tab.agentErrorMeta).toBeUndefined();
    // The map followed the conversion (the #2539 instrumentation) — no stale entry.
    expect(tabContent["ae1"]).toEqual(extractTabContent(tab));
    expect(tabContent["ae1"].contentType).toBe("terminal");
  });

  it("closing an agent-error tab prunes its map entry", () => {
    seedAgentErrorLayout();
    expect(useAppStore.getState().tabContent["ae1"]).toBeDefined();
    useAppStore.getState().closeTab("ae1", "a");
    expect(useAppStore.getState().tabContent["ae1"]).toBeUndefined();
  });

  // ── resolveAgentErrorTabs guard branches (TFE-005 / #3217) ──────────

  it("keeps the error tab when the agent's definition is still missing (!def)", () => {
    seedAgentErrorLayout();
    // The agent reconnected but this definition (def1) is not among its defs, so
    // the conversion must bail and leave the error tab intact.
    __emitAgentsViewForTest(
      {
        ...EMPTY_AGENTS_VIEW,
        agentDefinitions: {
          ag1: [
            {
              id: "some-other-def",
              name: "Other",
              sessionType: "local",
              config: { shell: "zsh" },
              persistent: false,
              folderId: null,
            },
          ],
        },
      },
      1
    );

    useAppStore.getState().resolveAgentErrorTabs("ag1");

    const tab = getAllLeaves(layoutState().rootPanel)[0].tabs[0];
    expect(tab.id).toBe("ae1");
    expect(tab.contentType).toBe("agent-error"); // unchanged — definition still missing
    expect(tab.agentErrorMeta?.agentId).toBe("ag1");
  });

  it("recurses through split containers to convert a nested agent-error tab", () => {
    // A split layout: left leaf holds an unrelated terminal tab, right leaf holds
    // the agent-error tab — exercising the `panel.type === 'split'` recursion.
    const errorTab = agentErrorTab("ae1");
    const otherTab: TerminalTab = {
      id: "t-left",
      sessionId: null,
      title: "Left",
      connectionType: "local",
      contentType: "terminal",
      config: { type: "local", config: {} } as ConnectionConfig,
      panelId: "left",
      isActive: true,
    } as TerminalTab;
    const root: PanelNode = {
      type: "split",
      id: "r",
      direction: "horizontal",
      children: [
        { type: "leaf", id: "left", tabs: [otherTab], activeTabId: "t-left" },
        { type: "leaf", id: "right", tabs: [errorTab], activeTabId: "ae1" },
      ],
      sizes: [50, 50],
    };
    useAppStore.setState(useAppStore.getInitialState());
    seedLayoutState({
      rootPanel: root,
      activePanelId: "right",
      tabGroups: [{ id: "g1", name: "Main", rootPanel: root, activePanelId: "right" }],
      activeTabGroupId: "g1",
      tabContent: { "t-left": extractTabContent(otherTab), ae1: extractTabContent(errorTab) },
    });
    __emitAgentsViewForTest(
      {
        ...EMPTY_AGENTS_VIEW,
        agentDefinitions: {
          ag1: [
            {
              id: "def1",
              name: "Def",
              sessionType: "local",
              config: { shell: "zsh" },
              persistent: false,
              folderId: null,
            },
          ],
        },
      },
      1
    );

    useAppStore.getState().resolveAgentErrorTabs("ag1");

    const leaves = getAllLeaves(layoutState().rootPanel);
    const converted = leaves.flatMap((l) => l.tabs).find((t) => t.id === "ae1");
    expect(converted?.contentType).toBe("terminal");
    expect(converted?.agentErrorMeta).toBeUndefined();
    // The unrelated tab in the sibling leaf is untouched.
    expect(leaves.flatMap((l) => l.tabs).find((t) => t.id === "t-left")?.contentType).toBe(
      "terminal"
    );
  });
});
