/**
 * The palette reaches everything the gear menu and the activity bar do
 * (#6158): every gear-menu item, every sidebar view and New connection…, each
 * with its own icon.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/components/Diagnostics/diagnosticsDialogStore", () => ({
  openDiagnosticsExport: vi.fn(),
}));

import { buildCommands } from "./commands";
import { clearOverrides } from "./keybindings";
import { useAppStore } from "@/store/appStore";
import { openDiagnosticsExport } from "@/components/Diagnostics/diagnosticsDialogStore";
import { useServicesView } from "@/components/ServicesSidebar/servicesView";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";

setupSettingsRegion();

const byLabel = (label: string) => buildCommands().find((c) => c.label === label);

describe("the palette reaches the gear menu and the activity bar (#6158)", () => {
  beforeEach(() => {
    clearOverrides();
    useAppStore.setState({ ...useAppStore.getInitialState() });
    seedSettings({ showRecentSessions: undefined });
  });

  it("offers every gear-menu item", () => {
    for (const label of [
      "Settings",
      "Keyboard shortcuts",
      "Customize layout…",
      "Open connections",
      "Updates",
      "Export diagnostics…",
      "About termiHub",
      "Log viewer",
    ]) {
      expect(byLabel(label), label).toBeDefined();
    }
  });

  it("runs each gear-menu item as the menu does", () => {
    const openOverlayView = vi.fn();
    const setLayoutDialogOpen = vi.fn();
    const openLogViewerTab = vi.fn();
    useAppStore.setState({ openOverlayView, setLayoutDialogOpen, openLogViewerTab });
    byLabel("Updates")!.run();
    byLabel("About termiHub")!.run();
    byLabel("Customize layout…")!.run();
    byLabel("Export diagnostics…")!.run();
    byLabel("Log viewer")!.run();
    byLabel("Open connections")!.run();
    expect(openOverlayView).toHaveBeenCalledWith("updates");
    expect(openOverlayView).toHaveBeenCalledWith("about");
    expect(setLayoutDialogOpen).toHaveBeenCalledWith(true);
    expect(openDiagnosticsExport).toHaveBeenCalled();
    expect(openLogViewerTab).toHaveBeenCalled();
    expect(useServicesView.getState().openConnections).toBe(true);
  });

  it("offers every sidebar view once, and New connection…", () => {
    const setSidebarView = vi.fn();
    const openConnectionEditorTab = vi.fn();
    useAppStore.setState({ setSidebarView, openConnectionEditorTab });
    for (const [label, view] of [
      ["Show connections", "connections"],
      ["Show file browser", "files"],
      ["Show recent sessions", "recent-sessions"],
      ["Show workspaces", "workspaces"],
      ["Show automations", "automations"],
      ["Show network tools", "network-tools"],
      ["Show plugins", "plugins"],
    ]) {
      byLabel(label)!.run();
      expect(setSidebarView, label).toHaveBeenLastCalledWith(view);
    }
    // Services has its own shortcut command already: not twice.
    expect(
      buildCommands().filter((c) => /services$/i.test(c.label) && c.label.startsWith("Show"))
    ).toHaveLength(1);
    byLabel("New connection…")!.run();
    expect(openConnectionEditorTab).toHaveBeenCalledWith("new");
  });

  it("leaves out a view its setting turned off", () => {
    seedSettings({ showRecentSessions: false });
    expect(byLabel("Show recent sessions")).toBeUndefined();
  });

  it("gives every command an icon, not all the same one", () => {
    const commands = buildCommands();
    expect(commands.every((c) => c.icon !== undefined)).toBe(true);
    expect(new Set(commands.map((c) => c.icon)).size).toBeGreaterThan(10);
  });
});
