/** The tunnel editor on the services' shell (#6028, slice 8). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() => Promise.resolve([{ name: "en0", addr: "192.168.1.20" }])),
}));

import { listNetworkInterfaces } from "@/services/embeddedServerApi";
import { useAppStore } from "@/store/appStore";
import { seedAgentsRegion, setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { checkA11y } from "@/test/axe";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import { byTestId, typeInto } from "@/test/dirtyDismiss";
import { flushAsync } from "@/test/flushAsync";
import { seedLayoutState } from "@/test/layoutState";
import { leaveField } from "@/test/leaveField";
import { withTooltip } from "@/test/tooltip";
import type { TunnelEditorMeta } from "@/types/terminal";
import type { TunnelConfig, TunnelStatus } from "@/types/tunnel";
import { TunnelEditor } from "./TunnelEditor";

const TAB = "tab-1";
const DB: TunnelConfig = {
  id: "db",
  name: "Shop database",
  sshConnectionId: "ssh-1",
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 15432, remoteHost: "db", remotePort: 5432 },
  },
  autoStart: false,
  reconnectOnDisconnect: false,
};
const SERVER = {
  id: "ssh-1",
  name: "Build Box",
  folderId: null,
  config: { type: "ssh", config: { host: "build.example", username: "u" } },
};

let container: HTMLDivElement;
let root: Root;
const actions = {
  saveTunnel: vi.fn(async (_tunnel: TunnelConfig) => {}),
  startTunnel: vi.fn(async (_id: string) => {}),
  reconnectTunnel: vi.fn(async (_id: string) => {}),
  closeTab: vi.fn(),
  openConnectionEditorTab: vi.fn(),
};

async function render(meta: Partial<TunnelEditorMeta> = {}) {
  await act(async () =>
    root.render(
      withTooltip(<TunnelEditor tabId={TAB} meta={{ tunnelId: null, ...meta }} isVisible={true} />)
    )
  );
  await flushAsync();
}
function seed(tunnel: TunnelConfig, status: TunnelStatus = "disconnected") {
  const stats = { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 };
  useAppStore.setState({
    tunnels: [tunnel],
    tunnelStates: { [tunnel.id]: { tunnelId: tunnel.id, status, stats } },
  });
}
const field = (name: string) => byTestId(`tunnel-editor-${name}`) as HTMLInputElement;
const press = async (name: string) => {
  await act(async () => field(name).click());
  await flushAsync();
};
const type = (name: string, value: string) => typeInto(`tunnel-editor-${name}`, value);
const text = (name: string) => field(name)?.textContent;
const saved = () => actions.saveTunnel.mock.calls[0][0].tunnelType.config;

setupAgentsRegion();
setupConnectionsRegion();

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({ ...useAppStore.getInitialState(), ...actions });
  seedAgentsRegion({ remoteAgents: [{ id: "a1", name: "Edge box", config: {} } as never] });
  seedConnectionsRegion({ connections: [SERVER as never] });
  seedLayoutState({
    rootPanel: { type: "leaf", id: "p", tabs: [{ id: TAB }], activeTabId: TAB } as never,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState(useAppStore.getInitialState());
});

describe("what one came for (U-008)", () => {
  it("comes first: the target, then the server, the port and who", async () => {
    await render({ tunnelType: "local" });
    expect(text("title")).toBe("Reach something through a server");
    expect(text("type-selector")).toBeUndefined();
    const order = [
      "remote-host",
      "remote-port",
      "ssh-connection",
      "host",
      "local-port",
      "bind-here",
      "sentence",
      "name",
      "description",
      "auto-start",
      "show-path",
      "save-start",
    ].map(field);
    for (let i = 1; i < order.length; i += 1) {
      const follows = order[i - 1].compareDocumentPosition(order[i]);
      expect(follows & Node.DOCUMENT_POSITION_FOLLOWING, String(i)).toBeTruthy();
    }
    expect(byTestId("tunnel-diagram")).toBeNull();
    await press("show-path");
    expect(byTestId("tunnel-diagram")).not.toBeNull();
    expect(field("show-path").getAttribute("aria-expanded")).toBe("true");
  });

  it.each([
    ["local", "remote-host", "localhost"],
    ["remote", "local-host", "localhost"],
    ["dynamic", "local-port", "1080"],
  ] as const)("of a new %s tunnel has the focus, and is typed over", async (kind, name, value) => {
    await render({ tunnelType: kind });
    expect(document.activeElement).toBe(field(name));
    expect(field(name).value).toBe(value);
    if (kind === "dynamic") return;
    expect(field(name).selectionEnd! - field(name).selectionStart!).toBe(value.length);
  });

  it("of a saved one has the focus, and is not typed over", async () => {
    seed({
      ...DB,
      tunnelType: { ...DB.tunnelType, config: { ...DB.tunnelType.config, remoteHost: "db.x" } },
    } as TunnelConfig);
    await render({ tunnelId: "db" });
    expect(text("title")).toBe("Shop database");
    expect(document.activeElement).toBe(field("remote-host"));
    expect(field("remote-host").selectionEnd! - field("remote-host").selectionStart!).toBe(0);
  });

  it("names a tunnel without a name, once it is known", async () => {
    await render({ tunnelType: "local" });
    leaveField(field("remote-host"));
    expect(field("name").value).toBe("");
    type("remote-host", "db.internal");
    leaveField(field("remote-host"));
    expect(field("name").value).toBe("db.internal");
    type("remote-host", "other");
    leaveField(field("remote-host"));
    expect(field("name").value).toBe("db.internal");
    expect(text("note")).toBe("");
  });

  it("asks for a connection when there is none, with a way to make one", async () => {
    seedConnectionsRegion({ connections: [] });
    await render({ tunnelType: "local" });
    expect(text("note")).toContain("an SSH connection");
    await press("new-connection");
    expect(actions.openConnectionEditorTab).toHaveBeenCalledWith("new");
    expect(text("sentence")).toContain("through the SSH server");
  });

  it("offers no new connection when there is one", async () => {
    await render({ tunnelType: "local" });
    expect(byTestId("tunnel-editor-new-connection")).toBeNull();
  });
});

describe("who can open it", () => {
  it.each([
    ["local", "localhost:8080 · only this computer", "localhost:80 through Build Box"],
    ["remote", "localhost:8080 · only on Build Box", "localhost:3000 from this computer"],
    [
      "dynamic",
      "socks5://localhost:1080 · only this computer",
      "proxy to SOCKS5, host localhost, port 1080. It then browses through Build Box.",
    ],
  ] as const)("is nobody else for a new %s tunnel (U-007)", async (kind, address, reaches) => {
    await render({ tunnelType: kind });
    expect(field("bind-here").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("tunnel-editor-warning")).toBeNull();
    expect(text("sentence")).toContain(address);
    expect(text("sentence")).toContain(reaches);
  });

  it("stores what is chosen, and warns", async () => {
    await render({ tunnelType: "local" });
    type("name", "x");
    await press("bind-network");
    expect(text("warning")).toContain("Anyone on your network can reach localhost:80");
    expect(text("sentence")).toContain("192.168.1.20:8080 · anyone on your network");
    await press("bind-address");
    expect(field("address").getAttribute("data-value")).toBe("192.168.1.20");
    await press("save");
    expect(saved()).toMatchObject({ localHost: "192.168.1.20" });
  });

  it("of a remote tunnel is about the server, whose address is typed", async () => {
    await render({ tunnelType: "remote" });
    type("name", "x");
    expect(text("bind")).toContain("Only Build Box itself");
    expect(listNetworkInterfaces).not.toHaveBeenCalled();
    await press("bind-network");
    expect(text("warning")).toContain("if the SSH server allows it (OpenSSH: GatewayPorts)");
    expect(text("sentence")).toContain("if its SSH server allows it");
    await press("bind-address");
    expect(text("note")).toBe("Still needed: who can open it");
    type("address", "10.0.0.5");
    await press("bind-here");
    await press("save");
    expect(saved()).toMatchObject({ remoteHost: "localhost", remotePort: 8080 });
  });

  it("keeps a saved address that is written in another way", async () => {
    seed({
      ...DB,
      tunnelType: { ...DB.tunnelType, config: { ...DB.tunnelType.config, localHost: "::1" } },
    } as TunnelConfig);
    await render({ tunnelId: "db" });
    expect(field("bind-here").getAttribute("aria-checked")).toBe("true");
    type("name", "y");
    await press("save");
    expect(saved()).toMatchObject({ localHost: "::1" });
  });

  it("starts anew with another kind", async () => {
    await render();
    await press("bind-address");
    await act(async () => byTestId("tunnel-type-remote")!.click());
    expect(field("bind-here").getAttribute("aria-checked")).toBe("true");
  });
});

describe("its port (V-002)", () => {
  it("is one that no service of this computer is set to", async () => {
    seed(DB);
    useAppStore.setState({ embeddedServers: [{ id: "s", name: "Docs", port: 8080 } as never] });
    await render({ tunnelType: "local" });
    expect(field("local-port").value).toBe("8081");
    type("local-port", "15432");
    expect(text("port-taken")).toBe('Port 15432 is used by "Shop database". Use 15433');
    await press("use-port");
    expect(field("local-port").value).toBe("15433");
  });

  it("of the tunnel itself is not taken, nor the server's of a remote one", async () => {
    seed(DB);
    await render({ tunnelId: "db" });
    expect(byTestId("tunnel-editor-port-taken")).toBeNull();
  });

  it("of a remote tunnel is the server's", async () => {
    seed(DB);
    await render({ tunnelType: "remote" });
    type("remote-port", "15432");
    expect(byTestId("tunnel-editor-port-taken")).toBeNull();
  });

  it("names a remote and a dynamic tunnel by what they are for (V-008)", async () => {
    await render({ tunnelType: "dynamic" });
    leaveField(field("local-port"));
    expect(field("name").value).toBe("Browse through Build Box");
    expect(field("name").placeholder).toBe("e.g. Office network");
  });
});

describe("a running tunnel", () => {
  it("says when changes apply, and can be restarted with them", async () => {
    seed(DB, "connected");
    await render({ tunnelId: "db" });
    expect(text("note")).toBe("");
    type("local-port", "15433");
    expect(text("note")).toBe("Changes apply when it restarts.");
    expect(text("save-start")).toBe("Save and restart");
    await press("save-start");
    expect(actions.reconnectTunnel).toHaveBeenCalledWith("db");
    expect(actions.startTunnel).not.toHaveBeenCalled();
    expect(actions.closeTab).toHaveBeenCalledWith(TAB, "p");
  });

  it("a stopped one is started", async () => {
    seed(DB);
    await render({ tunnelId: "db" });
    type("local-port", "15433");
    expect(text("note")).toBe("");
    expect(text("save-start")).toBe("Save and start");
    await press("save-start");
    expect(actions.startTunnel).toHaveBeenCalledWith("db");
  });
});

it("starts as chosen", async () => {
  await render({ tunnelType: "dynamic" });
  type("name", "Proxy");
  expect(text("form")).toContain("Start when a session to Build Box opens");
  // A new one reconnects, as connections do (V-007).
  expect(field("reconnect").getAttribute("aria-checked")).toBe("true");
  await press("auto-start");
  await press("save");
  expect(actions.saveTunnel.mock.calls[0][0]).toMatchObject({
    autoStart: true,
    startWithConnection: false,
    reconnectOnDisconnect: true,
  });
});

it("a saved tunnel keeps how it reconnects", async () => {
  seed(DB);
  await render({ tunnelId: "db" });
  expect(field("reconnect").getAttribute("aria-checked")).toBe("false");
});

it("has no accessibility violations, with the kinds, a warning, an error and the path", async () => {
  await render();
  await press("bind-network");
  await press("show-path");
  await press("save-start");
  expect(await checkA11y()).toHaveNoViolations();
});
