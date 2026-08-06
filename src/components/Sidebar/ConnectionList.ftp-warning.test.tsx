/**
 * Tests for the insecure-FTP warning modal in ConnectionList.handleConnect.
 *
 * The modal must appear before any connect (addTab) for a plain-FTP connection
 * (tlsMode "none") that has not been suppressed. FTPS and suppressed
 * connections connect immediately. Cancel aborts; Connect Anyway proceeds; the
 * "Don't warn again" toggle persists `suppressSecurityWarning` on the
 * connection via updateConnection (which never writes a password).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegionFromAppStore } from "@/test/connectionsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection, RemoteAgentDefinition } from "@/types/connection";

type AppState = ReturnType<typeof useAppStore.getState>;

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

vi.mock("./AgentNode", () => ({
  AgentNode: ({ agent }: { agent: RemoteAgentDefinition }) =>
    React.createElement("div", { "data-testid": `agent-node-${agent.id}` }),
}));

function makeFtpConn(id: string, config: Record<string, unknown>): SavedConnection {
  return {
    id,
    name: `FTP ${id}`,
    folderId: null,
    config: { type: "ftp", config: { host: "ftp.example.com", ...config } },
  };
}

let container: HTMLDivElement;
let root: Root;
let addTab: ReturnType<typeof vi.fn<AppState["addTab"]>>;
let updateConnection: ReturnType<typeof vi.fn<AppState["updateConnection"]>>;

function render(connections: SavedConnection[]) {
  addTab = vi.fn<AppState["addTab"]>();
  updateConnection = vi.fn<AppState["updateConnection"]>();
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    connections,
    addTab,
    updateConnection,
    credentialStoreStatus: { mode: "master_password", status: "unlocked" },
  });
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionList />
      </TooltipProvider>
    );
  });
}

async function clickConnectButton(id: string) {
  const item = container.querySelector(
    `[data-testid="connection-item-${id}"]`
  ) as HTMLElement | null;
  if (!item) throw new Error(`connection item for ${id} not found`);
  await act(async () => {
    item.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function queryModal(): HTMLElement | null {
  return document.querySelector('[data-testid="insecure-ftp-warning"]');
}

function clickTestId(testId: string) {
  const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  if (!el) throw new Error(`element ${testId} not found`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

setupConnectionsRegionFromAppStore();

describe("ConnectionList — insecure-FTP warning modal", () => {
  it("shows the modal before connecting for plain FTP", async () => {
    const conn = makeFtpConn("plain", { tlsMode: "none" });
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(queryModal()).not.toBeNull();
    expect(addTab).not.toHaveBeenCalled();
  });

  it("does not show the modal for FTPS (explicit)", async () => {
    const conn = makeFtpConn("ftps", { tlsMode: "explicit" });
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(queryModal()).toBeNull();
    expect(addTab).toHaveBeenCalledTimes(1);
  });

  it("does not show the modal when suppressSecurityWarning is set", async () => {
    const conn = makeFtpConn("suppressed", { tlsMode: "none", suppressSecurityWarning: true });
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);

    expect(queryModal()).toBeNull();
    expect(addTab).toHaveBeenCalledTimes(1);
  });

  it("Cancel aborts the connect", async () => {
    const conn = makeFtpConn("cancel", { tlsMode: "none" });
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);
    expect(queryModal()).not.toBeNull();

    clickTestId("confirm-dialog-cancel");

    expect(addTab).not.toHaveBeenCalled();
    expect(updateConnection).not.toHaveBeenCalled();
    expect(queryModal()).toBeNull();
  });

  it("Connect Anyway proceeds without persisting when the toggle is off", async () => {
    const conn = makeFtpConn("anyway", { tlsMode: "none" });
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);
    clickTestId("confirm-dialog-confirm");
    await act(async () => {
      await Promise.resolve();
    });

    expect(addTab).toHaveBeenCalledTimes(1);
    expect(updateConnection).not.toHaveBeenCalled();
  });

  it("persists suppressSecurityWarning when 'Don't warn again' is toggled", async () => {
    const conn = makeFtpConn("persist", { tlsMode: "none" });
    render([conn]);
    await act(async () => {
      await Promise.resolve();
    });

    await clickConnectButton(conn.id);
    clickTestId("confirm-dialog-dont-ask-again");
    clickTestId("confirm-dialog-confirm");
    await act(async () => {
      await Promise.resolve();
    });

    expect(updateConnection).toHaveBeenCalledTimes(1);
    const saved = updateConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.config.config.suppressSecurityWarning).toBe(true);
    // The credential is never part of the persisted config.
    expect(saved.config.config.password).toBeUndefined();
    expect(addTab).toHaveBeenCalledTimes(1);
  });
});
