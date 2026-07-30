/**
 * Tunnel host (run-location) tests for the TunnelEditor (S3, #2155): the
 * "Tunnel host" field, named endpoint lines naming the concrete machine, the
 * non-blocking reachability warning for an agent-hosted loopback listen, and its
 * "Widen bind" remediation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TunnelEditor } from "./TunnelEditor";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";
import type { TunnelConfig } from "@/types/tunnel";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-tun-host";
const PANEL_ID = "panel-tun-host";

const SSH_CONN: SavedConnection = {
  id: "ssh-1",
  name: "bastion",
  config: { type: "ssh", config: { host: "h", username: "u" } },
  folderId: null,
};

// The editor only reads id + name off a remote agent.
const AGENT = { id: "agent-1", name: "build-box" };

const AGENT_TUNNEL: TunnelConfig = {
  id: "tun-agent",
  name: "db",
  sshConnectionId: "ssh-1",
  tunnelType: {
    type: "local",
    config: {
      localHost: "127.0.0.1",
      localPort: 5432,
      remoteHost: "db.internal",
      remotePort: 5432,
    },
  },
  host: { kind: "agent", agentId: "agent-1" },
  autoStart: false,
  reconnectOnDisconnect: false,
};

const ROOT_PANEL = {
  type: "leaf",
  id: PANEL_ID,
  tabs: [{ id: TAB_ID }],
  activeTabId: TAB_ID,
};

let container: HTMLDivElement;
let root: Root;
let saveTunnel: ReturnType<typeof vi.fn>;

function render(tunnelId: string | null) {
  act(() => {
    root.render(
      <TooltipProvider>
        <TunnelEditor tabId={TAB_ID} meta={{ tunnelId }} isVisible={true} />
      </TooltipProvider>
    );
  });
}

function q(testid: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}

describe("TunnelEditor — tunnel host (S3, #2155)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    saveTunnel = vi.fn(() => Promise.resolve());
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [SSH_CONN],
      tunnels: [AGENT_TUNNEL],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      remoteAgents: [AGENT as any],
      saveTunnel,
      startTunnel: vi.fn(() => Promise.resolve()),
      closeTab: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rootPanel: ROOT_PANEL as any,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("exposes a Tunnel host field", () => {
    render(null);
    expect(q("tunnel-editor-host")).not.toBeNull();
  });

  it("names the concrete machine in the endpoint lines for a new (desktop) tunnel", () => {
    render(null);
    const endpoints = q("tunnel-editor-endpoints");
    expect(endpoints?.textContent).toContain("this computer");
    expect(endpoints?.textContent).toContain("Listens on");
    // No reachability warning for a desktop-hosted tunnel.
    expect(q("tunnel-editor-reachability")).toBeNull();
  });

  it("names the agent and warns for an agent-hosted loopback listen", () => {
    render("tun-agent");
    const endpoints = q("tunnel-editor-endpoints");
    expect(endpoints?.textContent).toContain("agent build-box");
    const warning = q("tunnel-editor-reachability");
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("build-box");
  });

  it("Widen bind rewrites the loopback listen to 0.0.0.0 and clears the warning", () => {
    render("tun-agent");
    const widen = q("tunnel-editor-widen-bind") as HTMLButtonElement;
    expect(widen).not.toBeNull();
    act(() => widen.click());
    // The warning is gone (bind is no longer loopback) and the endpoint line
    // reflects the widened address.
    expect(q("tunnel-editor-reachability")).toBeNull();
    expect(q("tunnel-editor-endpoints")?.textContent).toContain("0.0.0.0:5432");
  });

  it("persists the agent host through Save", async () => {
    render("tun-agent");
    const save = q("tunnel-editor-save") as HTMLButtonElement;
    await act(async () => {
      save.click();
    });
    expect(saveTunnel).toHaveBeenCalledTimes(1);
    const saved = saveTunnel.mock.calls[0][0] as TunnelConfig;
    expect(saved.host).toEqual({ kind: "agent", agentId: "agent-1" });
  });
});
