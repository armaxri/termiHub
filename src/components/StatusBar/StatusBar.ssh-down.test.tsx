/**
 * The status-bar SSH chip greys while the active tab's session is down
 * (#5955): a dropped session must not show the green "secure" shield of a
 * live one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { StatusBar } from "./StatusBar";
import type { ConnectionConfig, TerminalTab } from "@/types/terminal";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { flushAsync } from "@/test/flushAsync";
import { useSshHostKeyTrustStore } from "@/store/sshHostKeyTrustBridge";
import {
  connected,
  disconnected,
  flushSessionRegion,
  installSessionLifecycleHarness,
  reconnecting,
  withExit,
} from "@/test/sessionLifecycleRegionTestHarness";

vi.mock("@/components/CredentialStoreIndicator", () => ({
  CredentialStoreIndicator: () => null,
}));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

const harness = installSessionLifecycleHarness();
const TAB = "tab-1";
const SSH: ConnectionConfig = {
  type: "ssh",
  config: { host: "127.0.0.1", port: 22400, username: "arne", authMethod: "key", keyPath: "~/k" },
};

function setActiveTab() {
  const leafId = layoutState().rootPanel.id;
  const tab: TerminalTab = {
    id: TAB,
    sessionId: "s1",
    title: "target",
    connectionType: "ssh",
    contentType: "terminal",
    config: SSH,
    panelId: leafId,
    isActive: true,
  };
  seedLayoutState({
    rootPanel: { type: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
    activePanelId: leafId,
  });
}

function chip(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="status-bar-ssh"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe("StatusBar — SSH chip while the session is down (#5955)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useSshHostKeyTrustStore.setState({ byTab: {} });
    setActiveTab();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderWith(life: Parameters<typeof harness.transport.setSession>[1]) {
    harness.transport.setSession(TAB, life);
    act(() => root.render(React.createElement(StatusBar)));
    await flushSessionRegion();
    await flushAsync();
  }

  it("stays normal while the session is live", async () => {
    await renderWith(connected());
    expect(chip().dataset.down).toBeUndefined();
    expect(chip().classList).not.toContain("status-bar__item--down");
    expect(chip().getAttribute("aria-label")).not.toContain("Not connected");
  });

  it("greys and says so once the session dropped", async () => {
    await renderWith(withExit(disconnected("unexpected"), { code: null, reason: "dropped" }));
    expect(chip().dataset.down).toBe("true");
    expect(chip().classList).toContain("status-bar__item--down");
    expect(chip().getAttribute("aria-label")).toMatch(/^Not connected\. SSH: /);
    expect(chip().title).toMatch(/^Not connected\n/);
  });

  it("greys while a reconnect runs", async () => {
    await renderWith(reconnecting());
    expect(chip().dataset.down).toBe("true");
  });
});
