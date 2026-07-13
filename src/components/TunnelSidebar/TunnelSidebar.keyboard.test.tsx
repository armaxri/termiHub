/**
 * Keyboard-navigation + ARIA tree semantics for the Tunnels sidebar (#1379).
 *
 * The Tunnels list adopts the same roving-tabindex arrow-key model + tree ARIA
 * roles as the Connections tree: one row is tabbable at a time, arrows move the
 * roving focus, and Enter activates (edits) the focused tunnel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { TunnelConfig } from "@/types/tunnel";
import { TooltipProvider } from "@/components/ui";
import { TunnelSidebar } from "./TunnelSidebar";

vi.mock("@/store/appStore", () => {
  const state: Record<string, unknown> = {};
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useAppStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useAppStore };
});

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

const openTunnelEditorTab = vi.fn();

function seedStore() {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    tunnels: [makeTunnel("tun-1", "Alpha"), makeTunnel("tun-2", "Bravo")],
    tunnelStates: {},
    connections: [],
    startTunnel: vi.fn(),
    stopTunnel: vi.fn(),
    reconnectTunnel: vi.fn(),
    saveTunnel: vi.fn(),
    deleteTunnel: vi.fn(),
    openTunnelEditorTab,
  });
}

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function press(key: string) {
  const list = query("tunnel-list")!;
  act(() => {
    list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function renderSidebar() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <TunnelSidebar />
      </TooltipProvider>
    );
  });
}

describe("TunnelSidebar — keyboard navigation (#1379)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    seedStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("marks the list as a tree and rows as treeitems", () => {
    renderSidebar();
    expect(query("tunnel-list")!.getAttribute("role")).toBe("tree");
    const first = query("tunnel-item-tun-1")!;
    expect(first.getAttribute("role")).toBe("treeitem");
    expect(first.getAttribute("aria-level")).toBe("1");
  });

  it("keeps a single roving-tabindex row (first row tabbable)", () => {
    renderSidebar();
    expect(query("tunnel-item-tun-1")!.getAttribute("tabindex")).toBe("0");
    expect(query("tunnel-item-tun-2")!.getAttribute("tabindex")).toBe("-1");
  });

  it("moves the roving focus down with ArrowDown", () => {
    renderSidebar();
    press("ArrowDown");
    expect(document.activeElement).toBe(query("tunnel-item-tun-2"));
    expect(query("tunnel-item-tun-2")!.getAttribute("tabindex")).toBe("0");
    expect(query("tunnel-item-tun-1")!.getAttribute("tabindex")).toBe("-1");
  });

  it("activates (edits) the focused tunnel on Enter", () => {
    renderSidebar();
    press("ArrowDown");
    press("Enter");
    expect(openTunnelEditorTab).toHaveBeenCalledWith("tun-2");
  });
});
