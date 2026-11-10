/**
 * The Connections sidebar header carries one import entry point (#5195): an
 * "Import connections…" deep link to Settings → Import & Migration. The former
 * dedicated `~/.ssh/config` and CSV/inventory import icons are gone — imports are
 * one-time actions and live on the settings page (maintainer decision 2026-10-16).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import { flushAsync } from "@/test/flushAsync";
import type { RemoteAgentDefinition } from "@/types/connection";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

vi.mock("./AgentNode", () => ({
  AgentNode: ({
    agent,
    sectionRef,
  }: {
    agent: RemoteAgentDefinition;
    sectionRef?: (el: HTMLDivElement | null) => void;
  }) => React.createElement("div", { ref: sectionRef, "data-testid": `agent-node-${agent.id}` }),
}));

const baseSettings = {
  version: "1",
  externalConnectionFiles: [] as [],
  powerMonitoringEnabled: false,
  fileBrowserEnabled: false,
  experimentalFeaturesEnabled: false,
};

async function render(root: Root) {
  await act(async () => {
    root.render(
      React.createElement(TooltipProvider, {
        delayDuration: 0,
        children: React.createElement(ConnectionList),
      })
    );
  });
  // Let the projection subscriptions settle inside act (#3860).
  await flushAsync();
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

setupConnectionsRegion();
setupSettingsRegion();

describe("ConnectionList — import entry point (#5195)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ ...baseSettings });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("no longer renders the dedicated SSH-config and CSV import actions", async () => {
    await render(root);

    expect(container.querySelector('[data-testid="connection-list-import-ssh-config"]')).toBeNull();
    expect(container.querySelector('[data-testid="connection-list-import-csv"]')).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="connection-list-open-import-settings"]')
    ).toHaveLength(1);
  });

  it("deep-links the single import entry to Settings → Import & Migration", async () => {
    const openSettingsTab = vi.fn();
    useAppStore.setState({ openSettingsTab });
    await render(root);

    const entry = container.querySelector(
      '[data-testid="connection-list-open-import-settings"]'
    ) as HTMLButtonElement;
    expect(entry.getAttribute("aria-label")).toBe("Import connections…");
    click(entry);
    expect(openSettingsTab).toHaveBeenCalledWith({ category: "import" });
  });
});
