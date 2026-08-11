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
import { composeRenderTree, toMinimalNode, type LayoutView } from "./layoutBridge";
import { extractTabContent, useAppStore } from "./appStore";
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
  useAppStore.setState({
    rootPanel: root,
    activePanelId: "a",
    tabGroups: [{ id: "g1", name: "Main", rootPanel: root, activePanelId: "a" }],
    activeTabGroupId: "g1",
    tabContent: { ae1: extractTabContent(tab) },
  });
}

function currentView(): LayoutView {
  const { rootPanel, activePanelId } = useAppStore.getState();
  return {
    groups: [{ id: "g1", name: "Main", root: toMinimalNode(rootPanel), activePanelId }],
    activeGroupId: "g1",
  };
}

describe("appStore — agent-error tabs tracked in tabContent (#2539)", () => {
  beforeEach(() => {
    __emitAgentsViewForTest(EMPTY_AGENTS_VIEW, 0);
  });

  it("an agent-error tab resolves its content from the map (comprehensive)", () => {
    seedAgentErrorLayout();
    const { rootPanel, tabContent } = useAppStore.getState();
    const tab = getAllLeaves(rootPanel)[0].tabs[0];
    // The map holds a content-identical entry, carrying the agentErrorMeta.
    expect(tabContent["ae1"]).toEqual(extractTabContent(tab));
    expect(tabContent["ae1"].contentType).toBe("agent-error");
    expect(
      (tabContent["ae1"] as { agentErrorMeta?: { agentId: string } }).agentErrorMeta?.agentId
    ).toBe("ag1");
    // Render parity: composing from the map is byte-identical to the in-tree
    // fallback and to the authoritative tree — so the fallback is redundant.
    const view = currentView();
    expect(composeRenderTree(view, rootPanel, tabContent)).toEqual(
      composeRenderTree(view, rootPanel)
    );
    expect(composeRenderTree(view, rootPanel, tabContent)).toEqual(rootPanel);
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

    const { rootPanel, tabContent } = useAppStore.getState();
    const tab = getAllLeaves(rootPanel)[0].tabs[0];
    // Tree converted in place (same tab id — no remount).
    expect(tab.id).toBe("ae1");
    expect(tab.contentType).toBe("terminal");
    expect(tab.agentErrorMeta).toBeUndefined();
    // The map followed the conversion (the #2539 instrumentation) — no stale entry.
    expect(tabContent["ae1"]).toEqual(extractTabContent(tab));
    expect(tabContent["ae1"].contentType).toBe("terminal");
    // Render parity holds after the conversion.
    const view = currentView();
    expect(composeRenderTree(view, rootPanel, tabContent)).toEqual(rootPanel);
  });

  it("closing an agent-error tab prunes its map entry", () => {
    seedAgentErrorLayout();
    expect(useAppStore.getState().tabContent["ae1"]).toBeDefined();
    useAppStore.getState().closeTab("ae1", "a");
    expect(useAppStore.getState().tabContent["ae1"]).toBeUndefined();
  });
});
