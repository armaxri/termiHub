/**
 * The SSH chip after an agent setup tab ended (#5980).
 *
 * The setup tab runs the install over its own SSH session. After
 * "[Process exited with code 0]" the status bar still read
 * "SSH: user@host:port", as if a live session were open. The chip now hides
 * for a setup tab whose session has ended; a running setup and an ordinary
 * SSH tab keep it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { useAgentSetupStatus, type AgentSetupTab } from "@/store/agentSetupStatus";
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
  withExit,
} from "@/test/sessionLifecycleRegionTestHarness";

vi.mock("@/components/CredentialStoreIndicator", () => ({
  CredentialStoreIndicator: () => null,
}));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

const harness = installSessionLifecycleHarness();

const SSH: ConnectionConfig = {
  type: "ssh",
  config: { host: "127.0.0.1", port: 22400, username: "arne", authMethod: "key", keyPath: "~/k" },
};

function setActiveSshTab() {
  const leafId = layoutState().rootPanel.id;
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: "s1",
    title: "Setup: build-box",
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

function registerSetupTab(overrides: Partial<AgentSetupTab> = {}) {
  useAgentSetupStatus.setState({
    tabs: {
      "tab-1": {
        agentId: "agent-1",
        agentName: "build-box",
        reportsExit: true,
        progress: { kind: "running" },
        dismissed: false,
        ...overrides,
      },
    },
  });
}

function sshChip(): HTMLElement | null {
  return document.querySelector('[data-testid="status-bar-ssh"]');
}

describe("StatusBar — SSH chip on an ended setup tab (#5980)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useSshHostKeyTrustStore.setState({ byTab: {} });
    useAgentSetupStatus.setState({ phases: {}, tabs: {} });
    setActiveSshTab();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    act(() => root.render(React.createElement(StatusBar)));
    await flushAsync();
    await flushSessionRegion();
  }

  it("hides the chip once the setup's process exited", async () => {
    registerSetupTab();
    harness.transport.setSession(
      "tab-1",
      withExit(disconnected("unexpected"), { code: 0, reason: "clean" })
    );
    await render();
    expect(sshChip()).toBeNull();
  });

  it.each([
    { kind: "running" },
    { kind: "installed" },
    { kind: "unknown", message: "?" },
    { kind: "failed", message: "no" },
  ] as const)("hides the chip for a Windows exit 0 with outcome %o (#5992)", async (progress) => {
    registerSetupTab({ reportsExit: false, progress });
    harness.transport.setSession(
      "tab-1",
      withExit(disconnected("unexpected"), { code: 0, reason: "clean" })
    );
    await render();
    expect(sshChip()).toBeNull();
  });

  it("keeps the greyed chip when a setup's link dropped without an outcome", async () => {
    registerSetupTab();
    harness.transport.setSession(
      "tab-1",
      withExit(disconnected("unexpected"), { code: null, reason: "dropped" })
    );
    await render();
    expect(sshChip()?.getAttribute("data-down")).toBe("true");
  });

  it("keeps the chip while a setup that already failed is still connected", async () => {
    registerSetupTab({ progress: { kind: "failed", message: "SFTP" } });
    harness.transport.setSession("tab-1", connected());
    await render();
    expect(sshChip()).not.toBeNull();
  });

  it("keeps the chip while the setup still runs", async () => {
    registerSetupTab();
    harness.transport.setSession("tab-1", connected());
    await render();
    expect(sshChip()?.textContent).toContain("SSH: arne@127.0.0.1:22400");
  });

  it("keeps the chip on an ordinary SSH tab that ended", async () => {
    harness.transport.setSession(
      "tab-1",
      withExit(disconnected("unexpected"), { code: 0, reason: "clean" })
    );
    await render();
    expect(sshChip()).not.toBeNull();
  });
});
