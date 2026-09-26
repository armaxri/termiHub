/**
 * The SSH connection editor's "Port Forwarding" section (PROD-023).
 *
 * Pins that the section lists exactly the tunnels bound to the edited
 * connection (the same `tunnels` store the Tunnels sidebar renders — no second
 * store), and that add / edit / remove / "start with connection" route through
 * the shared tunnel actions: add + edit open the regular Tunnel editor (add
 * pre-bound to this connection), remove reuses the sidebar's confirm rules, and
 * the toggle upserts the same tunnel with `startWithConnection` flipped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { ConnectionPortForwardingSection } from "./ConnectionPortForwardingSection";

const saveTunnel = vi.fn((_config: TunnelConfig) => Promise.resolve());
const deleteTunnel = vi.fn((_id: string) => Promise.resolve());
const openTunnelEditorTab = vi.fn();

vi.mock("@/store/appStore", () => {
  const state: Record<string, unknown> = {};
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useAppStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useAppStore };
});

function tunnel(id: string, connectionId: string, extra: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    id,
    name: `Tunnel ${id}`,
    sshConnectionId: connectionId,
    tunnelType: {
      type: "local",
      config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
    },
    autoStart: false,
    reconnectOnDisconnect: false,
    ...extra,
  };
}

function state(id: string, status: TunnelState["status"]): TunnelState {
  return {
    tunnelId: id,
    status,
    stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
  };
}

function seed(tunnels: TunnelConfig[], tunnelStates: Record<string, TunnelState> = {}) {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    tunnels,
    tunnelStates,
    saveTunnel,
    deleteTunnel,
    openTunnelEditorTab,
  });
}

let container: HTMLDivElement;
let root: Root;

async function render(connectionId: string | undefined) {
  await act(async () => {
    root.render(<ConnectionPortForwardingSection connectionId={connectionId} />);
  });
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

async function click(el: HTMLElement | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

describe("ConnectionPortForwardingSection (PROD-023)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("asks to save first for an unsaved connection and offers no add", async () => {
    seed([tunnel("t1", "conn-1")]);
    await render(undefined);
    expect(byTestId("connection-port-forwarding-unsaved")).not.toBeNull();
    expect(byTestId("connection-port-forwarding-add")).toBeNull();
    expect(byTestId("port-forward-row-t1")).toBeNull();
  });

  it("lists only the tunnels bound to this connection, with mapping and status", async () => {
    seed([tunnel("t1", "conn-1"), tunnel("t2", "conn-2"), tunnel("t3", "conn-1")], {
      t1: state("t1", "connected"),
    });
    await render("conn-1");
    expect(byTestId("port-forward-row-t1")).not.toBeNull();
    expect(byTestId("port-forward-row-t3")).not.toBeNull();
    expect(byTestId("port-forward-row-t2")).toBeNull();
    expect(byTestId("port-forward-row-t1")!.textContent).toContain("127.0.0.1:5432 → db:5432");
    expect(byTestId("port-forward-row-t1")!.textContent).toContain("-L");
    expect(byTestId("port-forward-status-t1")!.textContent).toBe("connected");
    expect(byTestId("port-forward-status-t3")!.textContent).toBe("disconnected");
  });

  it("shows an empty state when nothing is attached", async () => {
    seed([tunnel("t2", "conn-2")]);
    await render("conn-1");
    expect(byTestId("connection-port-forwarding-empty")).not.toBeNull();
  });

  it("Add opens a new Tunnel editor pre-bound to this connection", async () => {
    seed([]);
    await render("conn-1");
    await click(byTestId("connection-port-forwarding-add"));
    expect(openTunnelEditorTab).toHaveBeenCalledWith(null, { sshConnectionId: "conn-1" });
  });

  it("Edit opens the Tunnel editor for that tunnel", async () => {
    seed([tunnel("t1", "conn-1")]);
    await render("conn-1");
    await click(byTestId("port-forward-edit-t1"));
    expect(openTunnelEditorTab).toHaveBeenCalledWith("t1");
  });

  it("the start-with-connection toggle upserts the same tunnel with the flag flipped", async () => {
    const t1 = tunnel("t1", "conn-1");
    seed([t1]);
    await render("conn-1");
    const toggle = byTestId("port-forward-start-with-connection-t1");
    expect(toggle!.getAttribute("aria-checked")).toBe("false");
    await click(toggle);
    expect(saveTunnel).toHaveBeenCalledWith({ ...t1, startWithConnection: true });
  });

  it("a chained companion shows no toggle (it follows its parent)", async () => {
    seed([tunnel("t1", "conn-1", { companionOf: "parent" })]);
    await render("conn-1");
    expect(byTestId("port-forward-start-with-connection-t1")).toBeNull();
  });

  it("Remove deletes an idle tunnel directly", async () => {
    seed([tunnel("t1", "conn-1")]);
    await render("conn-1");
    await click(byTestId("port-forward-remove-t1"));
    expect(byTestId("confirm-delete-dialog")).toBeNull();
    expect(deleteTunnel).toHaveBeenCalledWith("t1");
  });

  it("Remove confirms first for an active tunnel", async () => {
    seed([tunnel("t1", "conn-1")], { t1: state("t1", "connected") });
    await render("conn-1");
    await click(byTestId("port-forward-remove-t1"));
    expect(byTestId("confirm-delete-dialog")).not.toBeNull();
    expect(deleteTunnel).not.toHaveBeenCalled();
    await click(byTestId("confirm-delete-confirm"));
    expect(deleteTunnel).toHaveBeenCalledWith("t1");
  });
});
