/**
 * The status-bar running-services indicator (#4498, #5858).
 *
 * Services graduated from the experimental switch (#5858), so the indicator is
 * a button that opens the Services sidebar whether experimental features are
 * on or off.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import type { EmbeddedServerConfig } from "@/types/embeddedServer";
import type { TunnelConfig } from "@/types/tunnel";
import { StatusBar } from "./StatusBar";

setupSettingsRegion();

function renderStatusBar(root: Root) {
  root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)));
}

const STATS = { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 };

const server = (id: string): EmbeddedServerConfig => ({
  id,
  name: id,
  serverType: "http",
  rootDirectory: "/srv",
  bindHost: "127.0.0.1",
  port: 8080,
  autoStart: false,
  readOnly: true,
});

const tunnel = (id: string): TunnelConfig => ({
  id,
  name: id,
  sshConnectionId: "conn",
  tunnelType: { type: "dynamic", config: { localHost: "127.0.0.1", localPort: 1080 } },
  autoStart: false,
  reconnectOnDisconnect: false,
});

describe("StatusBar — services indicator (#4498, #5858)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let setSidebarView: ReturnType<typeof vi.fn<(view: string) => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    setSidebarView = vi.fn<(view: string) => void>();
    useAppStore.setState({
      embeddedServers: [server("s1")],
      embeddedServerStates: { s1: { status: "running", stats: STATS } as never },
      setSidebarView,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
  });

  const indicator = () =>
    container.querySelector<HTMLElement>('[data-testid="services-indicator"]');

  it("opens the Services sidebar on click with experimental features off (#5858)", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    act(() => renderStatusBar(root));
    await flushAsync();

    const item = indicator();
    expect(item).not.toBeNull();
    expect(item!.tagName).toBe("BUTTON");
    expect(item!.getAttribute("aria-label")).toBe("1 file server running — click to open Services");
    act(() => item!.click());
    expect(setSidebarView).toHaveBeenCalledWith("services");
  });

  it("opens the Services sidebar on click when experimental is on", async () => {
    seedSettings({ experimentalFeaturesEnabled: true });
    act(() => renderStatusBar(root));
    await flushAsync();

    const item = indicator();
    expect(item).not.toBeNull();
    expect(item!.tagName).toBe("BUTTON");
    expect(item!.getAttribute("aria-label")).toBe("1 file server running — click to open Services");
    act(() => item!.click());
    expect(setSidebarView).toHaveBeenCalledWith("services");
  });

  it("says a tunnel reconnects, also when nothing else runs (#6117, F-005)", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    useAppStore.setState({
      embeddedServers: [],
      embeddedServerStates: {},
      tunnels: [{ ...tunnel("Shop database"), reconnectOnDisconnect: true }],
      tunnelStates: {
        "Shop database": { status: "reconnecting", stats: STATS } as never,
      },
    });
    act(() => renderStatusBar(root));
    await flushAsync();
    const item = indicator();
    expect(item?.textContent).toBe("1 reconnecting");
    expect(item?.getAttribute("aria-label")).toMatch(/^Shop database.* — click to open Services$/);
  });

  it("counts tunnels, too (#6063)", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    const at = (status: string) => ({ status, stats: STATS });
    const tunnelStates = {
      a: at("connected"),
      b: at("connected"),
      c: at("notReachable"),
      // Of a tunnel that is not there.
      gone: at("connected"),
    } as never;
    const tunnels = ["a", "b", "c"].map(tunnel);
    useAppStore.setState({ tunnels, tunnelStates });
    act(() => renderStatusBar(root));
    await flushAsync();
    // What is not known needs a look (#6028, slice 6).
    expect(indicator()!.textContent).toBe("3 running · 1 needs attention");
    expect(indicator()!.getAttribute("aria-label")).toBe(
      "2 tunnels and 1 file server running, 1 needs attention — click to open Services"
    );

    act(() => useAppStore.setState({ embeddedServerStates: {} }));
    expect(indicator()!.textContent).toBe("2 running · 1 needs attention");
    act(() => indicator()!.click());
    expect(setSidebarView).toHaveBeenCalledWith("services");

    act(() => useAppStore.setState({ tunnelStates: {} }));
    expect(indicator()).toBeNull();
  });

  it("says errors, also when nothing runs (#6076)", async () => {
    const at = (status: string) => ({ status, stats: STATS });
    const states = { a: at("connected"), b: at("error"), c: at("error") } as never;
    useAppStore.setState({ tunnels: ["a", "b", "c"].map(tunnel), tunnelStates: states });
    act(() => renderStatusBar(root));
    await flushAsync();
    expect(indicator()!.textContent).toBe("2 running · 2 errors");
    expect(indicator()!.getAttribute("aria-label")).toBe(
      "1 tunnel and 1 file server running, 2 errors — click to open Services"
    );
    act(() =>
      useAppStore.setState({ embeddedServerStates: {}, tunnelStates: { b: at("error") } as never })
    );
    expect(indicator()!.textContent).toBe("1 error");
    expect(indicator()!.getAttribute("aria-label")).toBe("1 error — click to open Services");
  });

  it("says errors and what else needs a look together (#6028, slice 6)", async () => {
    const at = (status: string) => ({ status, stats: STATS });
    const states = { a: at("error"), b: at("notReachable") } as never;
    useAppStore.setState({
      tunnels: ["a", "b"].map(tunnel),
      tunnelStates: states,
      embeddedServerStates: {},
    });
    act(() => renderStatusBar(root));
    await flushAsync();
    expect(indicator()!.textContent).toBe("2 need attention");
  });

  it("does not count what ran on a removed agent (#6076)", async () => {
    const host = { kind: "agent", agentId: "removed" } as never;
    seedAgentsRegion({ remoteAgents: [] });
    useAppStore.setState({ embeddedServers: [{ ...server("s1"), host }] });
    act(() => renderStatusBar(root));
    await flushAsync();
    // Not counted as running; it may run there.
    expect(indicator()?.textContent).toBe("1 needs attention");
  });
});
