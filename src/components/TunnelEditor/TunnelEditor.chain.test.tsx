/**
 * "Chain a hop to this computer" affordance in the TunnelEditor (#2597): the
 * action sits on the agent-hosted loopback reachability warning beside "Widen
 * bind", is disabled while the host agent is offline, reads "Chained ✓ · reveal"
 * once a companion exists, and its preview's "Create & link" persists the parent
 * then the linked companion.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { TunnelEditor } from "./TunnelEditor";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";
import type { TunnelConfig } from "@/types/tunnel";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-chain";
const PANEL_ID = "panel-chain";

const SSH_CONN: SavedConnection = {
  id: "ssh-agent",
  name: "build-box ssh",
  config: { type: "ssh", config: { host: "build-box", username: "u" } },
  folderId: null,
};

const AGENT_TUNNEL: TunnelConfig = {
  id: "tun-agent",
  name: "db",
  sshConnectionId: "ssh-agent",
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

const COMPANION: TunnelConfig = {
  ...AGENT_TUNNEL,
  id: "tun-agent-hop",
  name: "db (hop on this computer)",
  host: { kind: "thisComputer" },
  companionOf: "tun-agent",
};

const ROOT_PANEL = {
  type: "leaf",
  id: PANEL_ID,
  tabs: [{ id: TAB_ID }],
  activeTabId: TAB_ID,
};

let container: HTMLDivElement;
let root: Root;
let saveTunnel: (config: TunnelConfig) => Promise<void>;
let openTunnelEditorTab: (id: string | null) => void;

function seedAgent(connectionState: "connected" | "disconnected") {
  const agent = {
    id: "agent-1",
    name: "build-box",
    connectionState,
    config: SSH_CONN.config.config,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  seedAgentsRegion({ remoteAgents: [agent] });
}

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
  return document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}

setupConnectionsRegion();
setupAgentsRegion();

describe("TunnelEditor — chain a hop (#2597)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    saveTunnel = vi.fn(() => Promise.resolve());
    openTunnelEditorTab = vi.fn();
    seedConnectionsRegion({ connections: [SSH_CONN] });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      tunnels: [AGENT_TUNNEL],
      saveTunnel,
      startTunnel: vi.fn(() => Promise.resolve()),
      closeTab: vi.fn(),
      openTunnelEditorTab,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedLayoutState({ rootPanel: ROOT_PANEL as any });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("offers 'Chain a hop' beside Widen bind when the host agent is online", () => {
    seedAgent("connected");
    render("tun-agent");
    const chain = q("tunnel-editor-chain-hop") as HTMLButtonElement | null;
    expect(chain).not.toBeNull();
    expect(chain!.disabled).toBe(false);
    expect(q("tunnel-editor-widen-bind")).not.toBeNull();
  });

  it("disables 'Chain a hop' while the host agent is offline", () => {
    seedAgent("disconnected");
    render("tun-agent");
    expect((q("tunnel-editor-chain-hop") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows 'Chained ✓ · reveal' once a companion exists", () => {
    seedAgent("connected");
    useAppStore.setState({ tunnels: [AGENT_TUNNEL, COMPANION] });
    render("tun-agent");
    expect(q("tunnel-editor-chain-hop")).toBeNull();
    const reveal = q("tunnel-editor-chain-reveal");
    expect(reveal).not.toBeNull();
    act(() => (reveal as HTMLButtonElement).click());
    expect(vi.mocked(openTunnelEditorTab)).toHaveBeenCalledWith("tun-agent-hop");
  });

  it("Create & link persists the parent then the linked companion", async () => {
    seedAgent("connected");
    render("tun-agent");
    await act(async () => (q("tunnel-editor-chain-hop") as HTMLButtonElement).click());
    // Preview is open with a defaulted SSH-via; confirm it.
    expect(q("tunnel-chain-preview")).not.toBeNull();
    await act(async () => {
      (q("tunnel-chain-confirm") as HTMLButtonElement).click();
    });
    await act(async () => Promise.resolve());

    expect(vi.mocked(saveTunnel)).toHaveBeenCalledTimes(2);
    const first = vi.mocked(saveTunnel).mock.calls[0][0];
    const second = vi.mocked(saveTunnel).mock.calls[1][0];
    expect(first.id).toBe("tun-agent");
    expect(second.companionOf).toBe("tun-agent");
    expect(second.host).toEqual({ kind: "thisComputer" });
    expect(second.sshConnectionId).toBe("ssh-agent");
  });
});
