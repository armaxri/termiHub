/**
 * The Connections sidebar must not say "Connections" twice (#5559): the panel
 * title names the view, so the first section below it carries a distinct name
 * ("Saved") while keeping its folder / new / import actions on that row, in
 * one "New ▾" menu (#5848).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { Sidebar } from "./Sidebar";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import { flushAsync } from "@/test/flushAsync";
import type { RemoteAgentDefinition } from "@/types/connection";
import { openConnectionsNewMenu, pickConnectionsNewMenuItem } from "@/test/connectionsNewMenu";

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

setupConnectionsRegion();
setupSettingsRegion();

describe("Connections sidebar — no duplicate heading (#5559)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ ...useAppStore.getInitialState(), sidebarView: "connections" });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(Sidebar),
        })
      );
    });
    await flushAsync();
  }

  for (const experimental of [false, true]) {
    it(`the panel title and the section titles all differ (experimental ${experimental})`, async () => {
      seedSettings({ ...baseSettings, experimentalFeaturesEnabled: experimental });
      await render();

      const panelTitle = container.querySelector(".sidebar__title")?.textContent;
      expect(panelTitle).toBe("Connections");
      const sections = Array.from(
        container.querySelectorAll(".connection-list__group-title"),
        (el) => el.textContent
      );
      expect(sections[0]).toBe("Saved");
      expect(sections.map((t) => t?.toLowerCase())).not.toContain(panelTitle!.toLowerCase());
    });
  }

  it("keeps the section's actions in one New menu on the renamed header row", async () => {
    seedSettings({ ...baseSettings });
    await render();
    const header = container.querySelector("[data-testid='sidebar-group-header-connections']")!;
    // One "New ▾" trigger, no bare icons (#5848, R-022).
    expect(header.querySelectorAll("button:not(.connection-list__group-toggle)")).toHaveLength(1);
    expect(header.querySelector("[data-testid='connection-list-new-menu']")).not.toBeNull();
    await openConnectionsNewMenu();
    for (const id of [
      "connection-list-new-folder",
      "connection-list-new-connection",
      "connection-list-open-import-settings",
    ]) {
      expect(document.querySelector(`[data-testid='${id}']`), id).not.toBeNull();
    }
  });

  it("New ▸ New folder opens the inline folder input and keeps its focus", async () => {
    seedSettings({ ...baseSettings });
    await render();
    await pickConnectionsNewMenuItem("connection-list-new-folder");
    const input = document.querySelector<HTMLInputElement>(
      "[data-testid='inline-folder-name-input']"
    );
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });
});
