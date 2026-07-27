/**
 * Desktop-local persistent-session controls in the connection tree (#1881),
 * updated for the tiered persistence badge (#2086).
 *
 * A saved connection whose type reports `capabilities.persistent === true`
 * surfaces a desktop-local persistence marker, a run-state dot, and
 * state-dependent Start / Attach / Stop controls (inline + context menu) wired
 * to the store's `startPersistentSession` / `attachPersistentSession` /
 * `stopPersistentSession` actions, keyed by the plain connection id.
 *
 * Per the #2086 maintainer decision, the desktop-local marker is NOT the ∞
 * (that is reserved for agent-backed persistence that survives app close +
 * machine restart). Desktop-local persistence lives only while the app is open,
 * so it renders a distinct, lesser Hourglass marker
 * (`local-persistent-badge-*`) whose tooltip does not overclaim. A
 * non-persistence-capable connection shows none of this and keeps the plain
 * Connect affordance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { TooltipProvider } from "@/components/ui";
import type {
  SavedConnection,
  ConnectionTypeInfo,
  PersistentSessionEntry,
  RemoteAgentDefinition,
} from "@/types/connection";
import type { PanelNode, TabGroup, TerminalTab } from "@/types/terminal";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

vi.mock("./AgentNode", () => ({
  AgentNode: ({ agent }: { agent: RemoteAgentDefinition }) =>
    React.createElement("div", { "data-testid": `agent-node-${agent.id}` }),
}));

const SSH_TYPE: ConnectionTypeInfo = {
  typeId: "ssh",
  displayName: "SSH",
  icon: "ssh",
  schema: { groups: [] },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: true },
};

const TELNET_TYPE: ConnectionTypeInfo = {
  typeId: "telnet",
  displayName: "Telnet",
  icon: "telnet",
  schema: { groups: [] },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

const SSH_CONN: SavedConnection = {
  id: "ssh-1",
  name: "My SSH",
  folderId: null,
  config: { type: "ssh", config: { host: "example.com" } },
};

const TELNET_CONN: SavedConnection = {
  id: "tel-1",
  name: "My Telnet",
  folderId: null,
  config: { type: "telnet", config: { host: "example.com" } },
};

let container: HTMLDivElement;
let root: Root;

function render(
  persistentSessions: Record<string, PersistentSessionEntry> = {},
  actionOverrides: Partial<{
    startPersistentSession: () => Promise<void>;
    attachPersistentSession: () => Promise<void>;
    stopPersistentSession: () => Promise<void>;
  }> = {},
  extra: Partial<{ rootPanel: PanelNode; tabGroups: TabGroup[]; activeTabGroupId: string }> = {}
) {
  const initial = useAppStore.getInitialState();
  useAppStore.setState({
    ...initial,
    connections: [SSH_CONN, TELNET_CONN],
    connectionTypes: [SSH_TYPE, TELNET_TYPE],
    persistentSessions,
    ...extra,
    ...actionOverrides,
  });
  act(() => {
    root.render(
      React.createElement(TooltipProvider, {
        delayDuration: 0,
        children: React.createElement(ConnectionList),
      })
    );
  });
}

function q(testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`);
}

function entry(
  state: PersistentSessionEntry["state"],
  attachedTabIds: string[] = []
): PersistentSessionEntry {
  return { connectionId: "ssh-1", sessionId: "sess-1", state, attachedTabIds };
}

function tab(id: string, title: string): TerminalTab {
  return {
    id,
    sessionId: "sess-1",
    title,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "example.com" } },
    panelId: "panel-1",
    isActive: false,
    persistentConnectionId: "ssh-1",
  };
}

/** A single-group layout whose active group's root panel holds `tabs`. */
function layoutWithTabs(tabs: TerminalTab[]): {
  rootPanel: PanelNode;
  tabGroups: TabGroup[];
  activeTabGroupId: string;
} {
  const rootPanel: PanelNode = {
    type: "leaf",
    id: "panel-1",
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  };
  const group: TabGroup = { id: "group-1", name: "Group 1", rootPanel, activePanelId: "panel-1" };
  return { rootPanel, tabGroups: [group], activeTabGroupId: "group-1" };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ConnectionList — desktop-local persistent controls", () => {
  it("shows the desktop-local (Hourglass) marker — NOT the ∞ — and state dot only for a persistence-capable connection", () => {
    render();
    // #2086: a plain SSH (desktop-local persistent) connection gets the lesser
    // Hourglass marker and MUST NOT carry the agent-only ∞.
    const marker = q("local-persistent-badge-ssh-1");
    expect(marker).not.toBeNull();
    expect(marker!.textContent ?? "").not.toContain("∞");
    // The ∞ badge (agent-backed testid) never renders on a desktop-local row.
    expect(q("persistent-badge-ssh-1")).toBeNull();
    expect(q("persistent-state-dot-ssh-1")).not.toBeNull();
    // Telnet is not persistence-capable — neither marker nor dot.
    expect(q("local-persistent-badge-tel-1")).toBeNull();
    expect(q("persistent-badge-tel-1")).toBeNull();
    expect(q("persistent-state-dot-tel-1")).toBeNull();
    // The non-persistent connection keeps the plain Connect affordance; the
    // persistent one does not.
    expect(q("connection-connect-tel-1")).not.toBeNull();
    expect(q("connection-connect-ssh-1")).toBeNull();
  });

  it("the desktop-local marker tooltip does not overclaim cross-restart persistence", () => {
    render();
    const title = q("local-persistent-badge-ssh-1")!.getAttribute("title") ?? "";
    expect(title).toContain("Runs while the app is open");
    // Must steer users to an agent for stronger persistence, and must not claim
    // it survives a machine restart.
    expect(title.toLowerCase()).toContain("agent");
    expect(title.toLowerCase()).not.toContain("machine");
  });

  it("reflects the run state on the state dot", () => {
    render();
    // No entry → stopped.
    expect(q("persistent-state-dot-ssh-1")!.className).toContain("state-dot--stopped");

    render({ "ssh-1": entry("running") });
    expect(q("persistent-state-dot-ssh-1")!.className).toContain("state-dot--running");

    render({ "ssh-1": entry("error") });
    expect(q("persistent-state-dot-ssh-1")!.className).toContain("state-dot--error");

    render({ "ssh-1": entry("starting") });
    expect(q("persistent-state-dot-ssh-1")!.className).toContain("state-dot--transitioning");
  });

  it("shows Start when stopped and calls startPersistentSession", () => {
    const startPersistentSession = vi.fn(() => Promise.resolve());
    render({}, { startPersistentSession });

    expect(q("persistent-start-ssh-1")).not.toBeNull();
    expect(q("persistent-attach-ssh-1")).toBeNull();
    expect(q("persistent-stop-ssh-1")).toBeNull();

    act(() => {
      q("persistent-start-ssh-1")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(startPersistentSession).toHaveBeenCalledWith("ssh-1");
  });

  it("shows Attach + Stop when running and calls the matching actions", () => {
    const attachPersistentSession = vi.fn(() => Promise.resolve());
    const stopPersistentSession = vi.fn(() => Promise.resolve());
    render({ "ssh-1": entry("running") }, { attachPersistentSession, stopPersistentSession });

    expect(q("persistent-start-ssh-1")).toBeNull();
    expect(q("persistent-attach-ssh-1")).not.toBeNull();
    expect(q("persistent-stop-ssh-1")).not.toBeNull();

    act(() => {
      q("persistent-attach-ssh-1")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(attachPersistentSession).toHaveBeenCalledWith("ssh-1");

    act(() => {
      q("persistent-stop-ssh-1")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(stopPersistentSession).toHaveBeenCalledWith("ssh-1");
  });

  it("hides inline lifecycle buttons while transitioning", () => {
    render({ "ssh-1": entry("starting") });
    expect(q("persistent-start-ssh-1")).toBeNull();
    expect(q("persistent-attach-ssh-1")).toBeNull();
    expect(q("persistent-stop-ssh-1")).toBeNull();
    // The desktop-local marker/dot still render.
    expect(q("local-persistent-badge-ssh-1")).not.toBeNull();
  });

  describe("attached-tab count badge (#1930)", () => {
    it("shows a count badge only when attached to more than one tab", () => {
      const tabs = [tab("t1", "Shell"), tab("t2", "Logs")];
      render({ "ssh-1": entry("attached", ["t1", "t2"]) }, {}, layoutWithTabs(tabs));
      const badge = q("persistent-state-dot-ssh-1-badge");
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe("2");
    });

    it("does not show the badge for a single attached tab", () => {
      render({ "ssh-1": entry("attached", ["t1"]) }, {}, layoutWithTabs([tab("t1", "Shell")]));
      expect(q("persistent-state-dot-ssh-1-badge")).toBeNull();
    });

    it("does not show the badge when running but not attached", () => {
      render({ "ssh-1": entry("running", ["t1", "t2"]) });
      expect(q("persistent-state-dot-ssh-1-badge")).toBeNull();
    });

    it("lists the attached tab names in the dot tooltip", () => {
      const tabs = [tab("t1", "Shell"), tab("t2", "Logs")];
      render({ "ssh-1": entry("attached", ["t1", "t2"]) }, {}, layoutWithTabs(tabs));
      const title = q("persistent-state-dot-ssh-1")!.getAttribute("title") ?? "";
      expect(title).toContain("2 tabs attached:");
      expect(title).toContain("Shell");
      expect(title).toContain("Logs");
    });
  });
});
