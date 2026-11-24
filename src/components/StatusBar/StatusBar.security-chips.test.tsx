/**
 * Tests for the status-bar security chips (#5839): the SSH chip is a button
 * with a trust shield and an accessible name that says "encrypted" and the
 * host key's trust, opening a popover with the host, encryption, sign-in and
 * host key plus a link to manage trusted keys; local shells get a chip with
 * the shell name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { StatusBar } from "./StatusBar";
import type { ConnectionConfig, TabContentType, TerminalTab } from "@/types/terminal";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { flushAsync } from "@/test/flushAsync";
import { recordSshHostKeyTrust, useSshHostKeyTrustStore } from "@/store/sshHostKeyTrustBridge";

vi.mock("@/components/CredentialStoreIndicator", () => ({
  CredentialStoreIndicator: () => null,
}));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

const SSH: ConnectionConfig = {
  type: "ssh",
  config: { host: "127.0.0.1", port: 22400, username: "arne", authMethod: "key", keyPath: "~/k" },
};

function setActiveTab(config: ConnectionConfig, contentType: TabContentType = "terminal") {
  const leafId = layoutState().rootPanel.id;
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: "s1",
    title: "target",
    connectionType: config.type,
    contentType,
    config,
    panelId: leafId,
    isActive: true,
  };
  seedLayoutState({
    rootPanel: { type: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
    activePanelId: leafId,
  });
}

function q(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

describe("StatusBar — security chips (#5839)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useSshHostKeyTrustStore.setState({ byTab: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    act(() => root.render(React.createElement(StatusBar)));
    await flushAsync();
  }

  async function openSshDetails() {
    const chip = q("status-bar-ssh")!;
    await act(async () => {
      chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();
  }

  it("renders the SSH chip as a button named with encryption and trust", async () => {
    setActiveTab(SSH);
    recordSshHostKeyTrust({
      owner: "tab-1:0",
      host: "127.0.0.1",
      port: 22400,
      key_type: "ssh-ed25519",
      fingerprint: "SHA256:abc",
      trust: "remembered",
    });
    await render();

    const chip = q("status-bar-ssh")!;
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.textContent).toBe("SSH: arne@127.0.0.1:22400");
    expect(chip.getAttribute("data-trust")).toBe("trusted");
    expect(chip.getAttribute("aria-label")).toBe(
      "SSH: arne@127.0.0.1:22400, encrypted, host key trusted. Show connection security"
    );
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    expect(q("status-bar-ssh-trust")).not.toBeNull();
  });

  it("opens a details popover with the host key and a manage-trust link", async () => {
    setActiveTab(SSH);
    recordSshHostKeyTrust({
      owner: "tab-1:0",
      host: "127.0.0.1",
      port: 22400,
      key_type: "ssh-ed25519",
      fingerprint: "SHA256:abc",
      trust: "firstSeenOnce",
    });
    const openSettingsTab = vi.fn();
    useAppStore.setState({ openSettingsTab });
    await render();
    await openSshDetails();

    expect(q("status-bar-ssh-details")).not.toBeNull();
    expect(q("status-bar-ssh-details-encryption")!.textContent).toBe("Encrypted (SSH)");
    expect(q("status-bar-ssh-details-auth")!.textContent).toBe("key ~/k");
    expect(q("status-bar-ssh-details-hostKey")!.textContent).toBe(
      "first seen, trusted once (this session only) · ssh-ed25519 SHA256:abc"
    );

    const manage = q("status-bar-ssh-manage-trust")!;
    await act(async () => {
      manage.click();
    });
    expect(openSettingsTab).toHaveBeenCalledWith({ category: "security" });
  });

  it("shows a pending shield before the connect reports the host key", async () => {
    setActiveTab(SSH);
    await render();
    expect(q("status-bar-ssh")!.getAttribute("data-trust")).toBe("pending");
  });

  it("shows the shell name for a local terminal tab", async () => {
    setActiveTab({ type: "local", config: { shell: "zsh" } });
    await render();
    const chip = q("status-bar-local-shell")!;
    expect(chip.textContent).toBe("Zsh");
    expect(chip.getAttribute("title")).toBe("Local shell: Zsh");
    expect(q("status-bar-ssh")).toBeNull();
  });

  it("shows no local-shell chip on a settings tab or an SSH tab", async () => {
    setActiveTab({ type: "local", config: { shell: "zsh" } }, "settings");
    await render();
    expect(q("status-bar-local-shell")).toBeNull();

    setActiveTab(SSH);
    await flushAsync();
    expect(q("status-bar-local-shell")).toBeNull();
  });
});
