/**
 * Default host-metric chips (#5754): local shell tabs show none and never start
 * a monitor unless the user opted in; remote sessions show CPU, Mem, Disk and
 * Net, with Swap left out of the default set but still selectable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { StatusBar } from "./StatusBar";
import type { AppSettings, ConnectionTypeInfo } from "@/types/connection";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import { ensureMonitorsSubscribed } from "@/store/systemMonitorBridge";
import {
  fakeMonitor,
  fakeStats,
  installMonitorHarness,
  monitorsView,
  type FakeMonitorTransport,
} from "@/test/systemMonitorHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";

vi.mock("@/components/CredentialStoreIndicator", () => ({ CredentialStoreIndicator: () => null }));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

setupSettingsRegion();

const KEY = "sess-1";

let transport: FakeMonitorTransport;
let teardownMonitors: () => void;

function primeTab(kind: "ssh" | "local", extraConfig: Record<string, unknown> = {}) {
  const type: ConnectionTypeInfo = {
    typeId: kind,
    displayName: kind === "ssh" ? "SSH" : "Local shell",
    icon: "server",
    schema: { groups: [] } as unknown as ConnectionTypeInfo["schema"],
    capabilities: { monitoring: true, fileBrowser: true, resize: true, persistent: false },
  };
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: KEY,
    title: kind === "ssh" ? "ssh-host" : "zsh",
    connectionType: kind,
    contentType: "terminal",
    config:
      kind === "ssh"
        ? { type: "ssh", config: { host: "host", port: 22, username: "user", ...extraConfig } }
        : { type: "local", config: { shell: "zsh", ...extraConfig } },
    panelId: "leaf-1",
    isActive: true,
  };
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs: [tab], activeTabId: "tab-1" };
  useAppStore.setState({ connectionTypes: [type] });
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

describe("StatusBar — default host-metric chips (#5754)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let connectMonitoring: ReturnType<typeof vi.fn<(key: string) => Promise<void>>>;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    ({ transport, teardown: teardownMonitors } = installMonitorHarness());
    await ensureMonitorsSubscribed();
    connectMonitoring = vi.fn((_key: string) => Promise.resolve());
    useAppStore.setState({ connectMonitoring });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    teardownMonitors();
  });

  async function render(settings: Partial<AppSettings> = {}) {
    seedSettings({ powerMonitoringEnabled: true, ...settings });
    // A live sample is cached for the tab, so only the setting decides the chips.
    transport.seed(
      monitorsView([
        fakeMonitor(KEY, {
          host: "host",
          monitorSessionId: KEY,
          stats: fakeStats("host", 30),
          sampleCount: 3,
        }),
      ])
    );
    await act(async () => {
      root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)));
    });
    await flushAsync();
  }

  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const chips = () =>
    ["cpu", "mem", "disk", "swap", "net"].filter((c) => q(`monitoring-${c}`) !== null);

  it("shows no metric chip and starts no monitor on a local shell tab", async () => {
    primeTab("local");
    await render();
    expect(chips()).toEqual([]);
    expect(q("monitoring-group")).toBeNull();
    expect(q("monitoring-stopped")).toBeNull();
    expect(connectMonitoring).not.toHaveBeenCalled();
  });

  it("monitors a local shell when the user opted in", async () => {
    primeTab("local");
    await render({ monitorLocalShells: true });
    expect(chips()).toEqual(["cpu", "mem", "disk", "net"]);
  });

  it("keeps a local connection's explicit enableMonitoring", async () => {
    primeTab("local", { enableMonitoring: true });
    await render();
    expect(chips()).toEqual(["cpu", "mem", "disk", "net"]);
  });

  it("shows CPU, Mem, Disk and Net on a remote session, without Swap", async () => {
    primeTab("ssh");
    await render();
    expect(chips()).toEqual(["cpu", "mem", "disk", "net"]);
  });

  it("shows Swap once the user selects it and keeps the explicit set", async () => {
    primeTab("ssh");
    await render({ statusBarMetrics: ["cpu", "swap"] });
    expect(chips()).toEqual(["cpu", "swap"]);
  });
});
