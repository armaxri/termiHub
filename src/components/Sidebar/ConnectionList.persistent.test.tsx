/**
 * Desktop-local persistent-session controls in the connection tree (#1881),
 * updated for the agents-only persistence marker rule (#2099).
 *
 * A saved connection whose type reports `capabilities.persistent === true`
 * still gets its state-dependent Start / Attach / Stop lifecycle controls
 * (inline + context menu) wired to the store's `startPersistentSession` /
 * `attachPersistentSession` / `stopPersistentSession` actions, keyed by the
 * plain connection id — the #1881 backend mechanism is unchanged.
 *
 * Per the #2099 maintainer decision, however, these desktop-local connections
 * (ssh/docker/wsl/serial/local) are multi-instance and die with the window, so
 * they carry NO persistence marker at all: no ∞, no hourglass, and no
 * persistence/run-state dot. The ∞ is reserved for agent persistent shells
 * (see AgentNode). A non-persistence-capable connection likewise shows none of
 * this and keeps the plain Connect affordance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegionFromAppStore } from "@/test/connectionsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import type {
  SavedConnection,
  ConnectionTypeInfo,
  PersistentSessionEntry,
  RemoteAgentDefinition,
} from "@/types/connection";

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
  }> = {}
) {
  const initial = useAppStore.getInitialState();
  useAppStore.setState({
    ...initial,
    connections: [SSH_CONN, TELNET_CONN],
    connectionTypes: [SSH_TYPE, TELNET_TYPE],
    persistentSessions,
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

function entry(state: PersistentSessionEntry["state"]): PersistentSessionEntry {
  return { connectionId: "ssh-1", sessionId: "sess-1", state, attachedTabIds: [] };
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

setupConnectionsRegionFromAppStore();

describe("ConnectionList — desktop-local persistent controls", () => {
  it("shows NO persistence marker and NO state dot for a plain (desktop-local) connection", () => {
    render({ "ssh-1": entry("running") });
    // #2099: a plain SSH connection is multi-instance and dies with the window,
    // so it carries no persistence surfacing whatsoever.
    expect(q("persistent-badge-ssh-1")).toBeNull(); // no ∞
    expect(q("local-persistent-badge-ssh-1")).toBeNull(); // no hourglass
    expect(q("persistent-state-dot-ssh-1")).toBeNull(); // no state dot
    expect(container.textContent ?? "").not.toContain("∞");
    // Telnet (not persistence-capable) also shows nothing.
    expect(q("persistent-badge-tel-1")).toBeNull();
    expect(q("local-persistent-badge-tel-1")).toBeNull();
    expect(q("persistent-state-dot-tel-1")).toBeNull();
    // The non-persistent connection keeps the plain Connect affordance; the
    // persistence-capable one still hides it in favour of the lifecycle controls.
    expect(q("connection-connect-tel-1")).not.toBeNull();
    expect(q("connection-connect-ssh-1")).toBeNull();
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

  it("hides inline lifecycle buttons while transitioning and still shows no marker", () => {
    render({ "ssh-1": entry("starting") });
    expect(q("persistent-start-ssh-1")).toBeNull();
    expect(q("persistent-attach-ssh-1")).toBeNull();
    expect(q("persistent-stop-ssh-1")).toBeNull();
    // No persistence marker or dot ever renders on a desktop-local row (#2099).
    expect(q("local-persistent-badge-ssh-1")).toBeNull();
    expect(q("persistent-badge-ssh-1")).toBeNull();
    expect(q("persistent-state-dot-ssh-1")).toBeNull();
  });
});
