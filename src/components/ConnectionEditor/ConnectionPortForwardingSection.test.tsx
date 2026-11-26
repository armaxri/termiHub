/**
 * The tunnels of an SSH connection in its editor (PROD-023; #6028, slice 13).
 *
 * A view of the same tunnels as Services: each is the Services row with its
 * actions, New tunnel opens the tunnel editor with this connection chosen, and
 * only "Start when a session opens" is this section's own. The Undo of a delete
 * is exercised against the real store in
 * `ConnectionPortForwardingSection.delete-undo.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useEditorViews } from "@/components/ServiceEditor/editorView";
import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { checkA11y } from "@/test/axe";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import { serviceMenuItem } from "@/test/serviceMenu";
import { withTooltip } from "@/test/tooltip";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { ConnectionPortForwardingSection } from "./ConnectionPortForwardingSection";

vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() => Promise.resolve([])),
}));

const actions = {
  saveTunnel: vi.fn((_config: TunnelConfig) => Promise.resolve()),
  startTunnel: vi.fn((_id: string) => Promise.resolve()),
  stopTunnel: vi.fn((_id: string) => Promise.resolve()),
  openTunnelEditorTab: vi.fn(),
  setSidebarView: vi.fn(),
};

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
  useAppStore.setState({ tunnels, tunnelStates });
}

let container: HTMLDivElement;
let root: Root;

async function render(connectionId: string | undefined) {
  await act(async () => {
    root.render(withTooltip(<ConnectionPortForwardingSection connectionId={connectionId} />));
  });
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`);

async function click(el: HTMLElement | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

setupAgentsRegion();
setupConnectionsRegion();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  useAppStore.setState({ ...useAppStore.getInitialState(), ...actions });
  seedConnectionsRegion({
    connections: [
      {
        id: "conn-1",
        name: "Build Box",
        folderId: null,
        config: { type: "ssh", config: { host: "build.example", username: "u" } },
      } as never,
    ],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState(useAppStore.getInitialState());
});

describe("the tunnels of a connection (#6028, slice 13)", () => {
  it("asks to save first for an unsaved connection and explains each type", async () => {
    seed([tunnel("t1", "conn-1")]);
    await render(undefined);
    const unsaved = byTestId("connection-port-forwarding-unsaved")!;
    expect(unsaved.textContent).toContain("Save this connection first");
    expect(unsaved.textContent).toContain("ssh -L");
    expect(unsaved.textContent).toContain("ssh -D");
    expect(byTestId("connection-port-forwarding-add")).toBeNull();
    expect(byTestId("tunnel-item-t1")).toBeNull();
  });

  it("lists only this connection's tunnels, on the rows of Services", async () => {
    seed([tunnel("t1", "conn-1"), tunnel("t2", "other"), tunnel("t3", "conn-1")], {
      t1: state("t1", "connected"),
    });
    await render("conn-1");
    expect(byTestId("tunnel-item-t1")).not.toBeNull();
    expect(byTestId("tunnel-item-t3")).not.toBeNull();
    expect(byTestId("tunnel-item-t2")).toBeNull();
    // The row's own words: state, address with Copy.
    expect(byTestId("tunnel-kind-t1")!.textContent).toContain("Running");
    expect(byTestId("tunnel-address-t1")!.textContent).toContain("localhost:5432");
    expect(byTestId("tunnel-kind-t3")!.textContent).toContain("Stopped");
    expect(document.querySelector("h3")!.textContent).toBe("SSH tunnels");
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it("says when none goes through it, and makes a new one with it chosen", async () => {
    seed([tunnel("t2", "other")]);
    await render("conn-1");
    expect(byTestId("connection-port-forwarding-empty")!.textContent).toContain(
      "No tunnels go through this connection yet."
    );
    await click(byTestId("connection-port-forwarding-add"));
    expect(byTestId("connection-port-forwarding-add")!.textContent).toBe("New tunnel");
    expect(actions.openTunnelEditorTab).toHaveBeenCalledWith(null, { sshConnectionId: "conn-1" });
  });

  it("the row's buttons do what they do in Services", async () => {
    seed([tunnel("t1", "conn-1")]);
    await render("conn-1");
    await click(byTestId("tunnel-start-t1"));
    expect(actions.startTunnel).toHaveBeenCalledWith("t1");
    await click(byTestId("tunnel-edit-t1"));
    expect(actions.openTunnelEditorTab).toHaveBeenLastCalledWith("t1");
    expect(useEditorViews.getState().views.t1).toBe("settings");
    await click(byTestId("tunnel-activity-t1"));
    expect(useEditorViews.getState().views.t1).toBe("activity");
  });

  it("Delete asks first, as in Services", async () => {
    seed([tunnel("t1", "conn-1")]);
    await render("conn-1");
    await click(serviceMenuItem("tunnel-delete-t1"));
    expect(byTestId("confirm-delete-dialog")).not.toBeNull();
  });

  it("Show in Services opens the Services view", async () => {
    seed([tunnel("t1", "conn-1")]);
    await render("conn-1");
    await click(byTestId("connection-port-forwarding-show-services"));
    expect(actions.setSidebarView).toHaveBeenCalledWith("services");
  });

  it("starting with a session saves the same tunnel with the flag flipped", async () => {
    const t1 = tunnel("t1", "conn-1", { startWithConnection: false });
    seed([t1]);
    await render("conn-1");
    const toggle = byTestId("port-forward-start-with-connection-t1")!;
    expect(toggle.getAttribute("aria-label")).toBe(
      "Start Tunnel t1 when a session to this connection opens"
    );
    await click(toggle);
    expect(actions.saveTunnel).toHaveBeenCalledWith({ ...t1, startWithConnection: true });
  });

  it("a chained companion follows its parent and has no switch", async () => {
    seed([tunnel("t1", "conn-1", { companionOf: "parent" })]);
    await render("conn-1");
    expect(byTestId("port-forward-start-with-connection-t1")).toBeNull();
    expect(container.textContent).toContain("Follows its chained parent");
  });
});
