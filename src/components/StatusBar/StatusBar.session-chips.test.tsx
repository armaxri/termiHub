/**
 * Tests for the status-bar session chips (#5628): the SSH chip on every SSH
 * tab (not only jump-host ones), the serial port/line-settings chip, and the
 * credential-lock item pinned to the right group.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { StatusBar } from "./StatusBar";
import type { ConnectionConfig, TerminalTab } from "@/types/terminal";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { flushAsync } from "@/test/flushAsync";
import { recordSshHostKeyTrust, useSshHostKeyTrustStore } from "@/store/sshHostKeyTrustBridge";

vi.mock("@/components/CredentialStoreIndicator", () => ({
  CredentialStoreIndicator: () =>
    React.createElement("span", { "data-testid": "credential-store-indicator" }),
}));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

function setActiveTab(config: ConnectionConfig) {
  const leafId = layoutState().rootPanel.id;
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: "s1",
    title: "target",
    connectionType: config.type,
    contentType: "terminal",
    config,
    panelId: leafId,
    isActive: true,
  };
  seedLayoutState({
    rootPanel: { type: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
    activePanelId: leafId,
  });
}

describe("StatusBar — session chips (#5628)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    act(() => root.render(React.createElement(StatusBar)));
    await flushAsync();
  }

  it("shows the SSH chip for a direct key-auth tab", async () => {
    setActiveTab({
      type: "ssh",
      config: {
        host: "127.0.0.1",
        port: 22400,
        username: "arne",
        authMethod: "key",
        keyPath: "~/.ssh/pr_ed25519",
      },
    });
    await render();

    const chip = container.querySelector('[data-testid="status-bar-ssh"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("SSH: arne@127.0.0.1:22400");
    expect(chip!.getAttribute("title")).toContain("Auth: key ~/.ssh/pr_ed25519");
  });

  it("adds the host-key trust state once the tab's connect accepted the key (#5669)", async () => {
    useSshHostKeyTrustStore.setState({ byTab: {} });
    setActiveTab({ type: "ssh", config: { host: "box", username: "u", authMethod: "agent" } });
    await render();
    const chip = () => container.querySelector('[data-testid="status-bar-ssh"]');
    expect(chip()!.getAttribute("title")).not.toContain("Host key");

    act(() =>
      recordSshHostKeyTrust({
        owner: "tab-1:0",
        host: "box",
        port: 22,
        key_type: "ssh-ed25519",
        fingerprint: "SHA256:abc",
        trust: "firstSeenRemembered",
      })
    );
    expect(chip()!.getAttribute("title")).toContain(
      "Host key: first seen, accepted and remembered (SHA256:abc)"
    );
  });

  it("shows host:port for both ends of a jump", async () => {
    setActiveTab({
      type: "ssh",
      config: {
        host: "127.0.0.1",
        port: 22400,
        username: "arne",
        proxyJump: [{ host: "127.0.0.1", port: 22401, username: "arne", authMethod: "key" }],
      },
    });
    await render();

    const chip = container.querySelector('[data-testid="status-bar-ssh"]');
    expect(chip!.textContent).toContain("SSH: arne@127.0.0.1:22400 via 127.0.0.1:22401");
  });

  it("shows the serial port and line settings", async () => {
    setActiveTab({
      type: "serial",
      config: { port: "/dev/ttyPR0", baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1 },
    });
    await render();

    expect(container.querySelector('[data-testid="status-bar-ssh"]')).toBeNull();
    const chip = container.querySelector('[data-testid="status-bar-serial"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("/dev/ttyPR0 · 9600 8N1");
  });

  it("pins the credential-lock item to the right group", async () => {
    setActiveTab({ type: "ssh", config: { host: "h", username: "u" } });
    await render();

    const lock = container.querySelector('[data-testid="credential-store-indicator"]');
    expect(lock).not.toBeNull();
    expect(lock!.closest(".status-bar__section--right")).not.toBeNull();
  });
});
