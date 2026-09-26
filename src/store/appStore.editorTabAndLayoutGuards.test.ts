import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Branch-coverage suite (#3027, TFE-005 follow-up) for guard / focus-existing
 * branches in `appStore.ts` that the existing error-branch suites leave dark:
 *
 *  - `openTunnelEditorTab` / `openWorkspaceEditorTab`: the "an editor for this id
 *    is already open → focus it instead of opening a second" branch, plus the
 *    `Edit: <name>` title branch that only fires when the referenced tunnel /
 *    workspace exists. The zero-leaf no-op path is covered elsewhere
 *    (`appStore.openTabNoPanelGuards.test.ts`); these drive the populated tree.
 *  - `addTabGroupWithTab`: the unknown-source-panel and unknown-tab early
 *    returns (a stray drag id must never mint a new group).
 *  - `clearPendingScrollbackReplay`: the unknown-tab guard (a replay-clear for a
 *    tab that no longer exists must be a safe no-op, not a throw).
 *
 * These actions operate purely on the composed layout held in `appStore`, so the
 * suite needs no service mocks beyond the theme side-effect stub.
 */

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

import { useAppStore } from "./appStore";
import { layoutState } from "@/test/layoutState";
import { getAllLeaves } from "@/utils/panelTree";
import type { TerminalTab } from "@/types/terminal";
import type { TunnelConfig } from "@/types/tunnel";
import type { WorkspaceSummary } from "@/types/workspace";

function makeTunnel(id: string, name: string): TunnelConfig {
  return {
    id,
    name,
    sshConnectionId: "conn-1",
    tunnelType: {
      type: "local",
      config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80 },
    },
    autoStart: false,
    reconnectOnDisconnect: false,
  };
}

function workspaceSummary(id: string, name: string): WorkspaceSummary {
  return { id, name, connectionCount: 0 };
}

/** Every live tab across the composed layout. */
function allTabs(): TerminalTab[] {
  return getAllLeaves(layoutState().rootPanel).flatMap((leaf) => leaf.tabs);
}

/** The single leaf id of the default single-panel layout. */
function activeLeafId(): string {
  return getAllLeaves(layoutState().rootPanel)[0].id;
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

describe("appStore — openTunnelEditorTab focus-existing / title branches", () => {
  it("titles the tab 'Edit: <name>' when the referenced tunnel exists", () => {
    useAppStore.setState({ tunnels: [makeTunnel("tun-1", "My Tunnel")] });

    useAppStore.getState().openTunnelEditorTab("tun-1");

    const editors = allTabs().filter(
      (t) => t.contentType === "tunnel-editor" && t.tunnelEditorMeta?.tunnelId === "tun-1"
    );
    expect(editors).toHaveLength(1);
    expect(editors[0].title).toBe("Edit: My Tunnel");
  });

  it("focuses the already-open editor instead of opening a second tab", () => {
    useAppStore.setState({ tunnels: [makeTunnel("tun-1", "My Tunnel")] });

    useAppStore.getState().openTunnelEditorTab("tun-1");
    const firstId = allTabs().find((t) => t.contentType === "tunnel-editor")?.id;

    // A second request for the same tunnel must re-focus, not duplicate.
    useAppStore.getState().openTunnelEditorTab("tun-1");

    const editors = allTabs().filter((t) => t.contentType === "tunnel-editor");
    expect(editors).toHaveLength(1);
    expect(editors[0].id).toBe(firstId);
    // The re-focused tab is the active tab of its leaf.
    const leaf = getAllLeaves(layoutState().rootPanel).find((l) =>
      l.tabs.some((t) => t.id === firstId)
    );
    expect(leaf?.activeTabId).toBe(firstId);
    expect(leaf?.tabs.find((t) => t.id === firstId)?.isActive).toBe(true);
  });
});

describe("appStore — openTunnelEditorTab connection prefill (PROD-023)", () => {
  function editorMetas() {
    return allTabs()
      .filter((t) => t.contentType === "tunnel-editor")
      .map((t) => t.tunnelEditorMeta);
  }

  it("carries the connection on a new-tunnel editor and reuses only a matching tab", () => {
    const open = useAppStore.getState().openTunnelEditorTab;
    open(null, { sshConnectionId: "conn-1" });
    expect(editorMetas()).toEqual([{ tunnelId: null, sshConnectionId: "conn-1" }]);

    // The same prefill focuses the existing tab rather than opening another.
    open(null, { sshConnectionId: "conn-1" });
    expect(editorMetas()).toHaveLength(1);

    // A plain "New Tunnel" is a different editor.
    open(null);
    expect(editorMetas()).toEqual([
      { tunnelId: null, sshConnectionId: "conn-1" },
      { tunnelId: null },
    ]);
  });

  it("ignores the prefill when editing an existing tunnel", () => {
    useAppStore.setState({ tunnels: [makeTunnel("tun-1", "My Tunnel")] });
    useAppStore.getState().openTunnelEditorTab("tun-1", { sshConnectionId: "conn-9" });
    expect(editorMetas()).toEqual([{ tunnelId: "tun-1" }]);
  });
});

describe("appStore — openWorkspaceEditorTab focus-existing / title branches", () => {
  it("titles the tab 'Edit: <name>' when the referenced workspace exists", () => {
    useAppStore.setState({ workspaces: [workspaceSummary("ws-1", "Prod")] });

    useAppStore.getState().openWorkspaceEditorTab("ws-1");

    const editors = allTabs().filter(
      (t) => t.contentType === "workspace-editor" && t.workspaceEditorMeta?.workspaceId === "ws-1"
    );
    expect(editors).toHaveLength(1);
    expect(editors[0].title).toBe("Edit: Prod");
  });

  it("focuses the already-open editor instead of opening a second tab", () => {
    useAppStore.setState({ workspaces: [workspaceSummary("ws-1", "Prod")] });

    useAppStore.getState().openWorkspaceEditorTab("ws-1");
    const firstId = allTabs().find((t) => t.contentType === "workspace-editor")?.id;

    useAppStore.getState().openWorkspaceEditorTab("ws-1");

    const editors = allTabs().filter((t) => t.contentType === "workspace-editor");
    expect(editors).toHaveLength(1);
    expect(editors[0].id).toBe(firstId);
    const leaf = getAllLeaves(layoutState().rootPanel).find((l) =>
      l.tabs.some((t) => t.id === firstId)
    );
    expect(leaf?.activeTabId).toBe(firstId);
  });
});

describe("appStore — addTabGroupWithTab guards", () => {
  it("is a no-op when the source panel does not exist (no new group)", () => {
    const before = layoutState().tabGroups.length;

    useAppStore.getState().addTabGroupWithTab("any-tab", "ghost-panel");

    expect(layoutState().tabGroups).toHaveLength(before);
  });

  it("is a no-op when the tab is not in the source panel (no new group)", () => {
    const before = layoutState().tabGroups.length;

    // The active leaf exists but is empty, so the tab id resolves to nothing.
    useAppStore.getState().addTabGroupWithTab("ghost-tab", activeLeafId());

    expect(layoutState().tabGroups).toHaveLength(before);
  });
});

describe("appStore — clearPendingScrollbackReplay unknown-tab guard", () => {
  it("is a safe no-op for a tab that no longer exists", () => {
    const before = { ...useAppStore.getState().tabContent };

    expect(() => useAppStore.getState().clearPendingScrollbackReplay("ghost-tab")).not.toThrow();

    expect(useAppStore.getState().tabContent).toEqual(before);
  });
});

describe("appStore — renameTab unknown-tab guard", () => {
  it("is a safe no-op for a tab that no longer exists", () => {
    const before = { ...useAppStore.getState().tabContent };

    expect(() => useAppStore.getState().renameTab("ghost-tab", "New Name")).not.toThrow();

    expect(useAppStore.getState().tabContent).toEqual(before);
  });
});

describe("appStore — setTabColor set / clear branches", () => {
  it("sets a color and then clears it when passed null", () => {
    useAppStore.getState().setTabColor("tab-1", "#ff0000");
    expect(useAppStore.getState().tabColors["tab-1"]).toBe("#ff0000");

    // A null color removes the entry (the omitKey branch) rather than storing null.
    useAppStore.getState().setTabColor("tab-1", null);
    expect(useAppStore.getState().tabColors["tab-1"]).toBeUndefined();
  });
});

describe("appStore — moveTabToGroup same-group guard", () => {
  it("is a no-op when the target group is already the active group", () => {
    const activeGroup = layoutState().activeTabGroupId;
    const before = layoutState().rootPanel;

    useAppStore.getState().moveTabToGroup("any-tab", activeLeafId(), activeGroup);

    expect(layoutState().rootPanel).toEqual(before);
  });
});

describe("appStore — openTunnelEditorTab title for an unknown tunnel id", () => {
  it("titles a brand-new editor 'New Tunnel' when the id resolves to no tunnel", () => {
    // No tunnels seeded, so the id matches nothing → the `if (tunnel)` false arm.
    useAppStore.getState().openTunnelEditorTab("missing-tunnel");

    const editor = allTabs().find((t) => t.contentType === "tunnel-editor");
    expect(editor?.title).toBe("New Tunnel");
  });
});
