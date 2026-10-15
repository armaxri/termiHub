/**
 * Test helper for carrying a dirty form editor to another window (#4500).
 *
 * Seeds the editor's tab into the layout, runs the real "Move tabs" hand-off
 * (`moveWindowSessionsToWindow`) and captures the record the frontend sends
 * through the mocked `send_handoff_to_window` IPC command, then hydrates that
 * record as the destination window does and returns the new tab's id, so a
 * test can mount the editor there and check the draft came back.
 */
import { vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { collectWindowTabs } from "@/store/layoutHelpers";
import type { PanelNode, TerminalTab } from "@/types/terminal";
import type { TabHandoffRecord } from "@/types/window";
import { seedLayoutState } from "./layoutState";

/** Install a one-panel layout holding `tab` alone. */
export function seedSingleTab(tab: TerminalTab): void {
  const rootPanel: PanelNode = {
    type: "leaf",
    id: tab.panelId,
    tabs: [{ ...tab, isActive: true }],
    activeTabId: tab.id,
  };
  seedLayoutState({
    rootPanel,
    activePanelId: tab.panelId,
    tabGroups: [{ id: "g1", name: "Main", rootPanel, activePanelId: tab.panelId }],
    activeTabGroupId: "g1",
  });
}

/** Every record sent through `send_handoff_to_window` so far. */
export function sentHandoffs(): TabHandoffRecord[] {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "send_handoff_to_window")
    .map(([, args]) => (args as { handoff: TabHandoffRecord }).handoff);
}

/** Move this window's tabs to `win-1` and return the one record sent. */
export async function moveTabs(): Promise<TabHandoffRecord> {
  await useAppStore.getState().moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });
  const records = sentHandoffs();
  if (records.length !== 1) throw new Error(`expected one hand-off, got ${records.length}`);
  return records[0];
}

/**
 * Hydrate `record` as the destination window does, in a layout holding only
 * the destination's own panel `panelId`. Returns the new tab's id.
 */
export function hydrateInDestination(record: TabHandoffRecord, panelId: string): string {
  const empty: PanelNode = { type: "leaf", id: panelId, tabs: [], activeTabId: null };
  seedLayoutState({
    rootPanel: empty,
    activePanelId: panelId,
    tabGroups: [{ id: "g1", name: "Main", rootPanel: empty, activePanelId: panelId }],
    activeTabGroupId: "g1",
  });
  useAppStore.setState({ editorDirtyTabs: {} });
  useAppStore.getState().hydrateHandoffTab(record);
  const tab = collectWindowTabs(useAppStore.getState()).find(
    (t) => t.contentType === record.tab.contentType
  );
  if (!tab) throw new Error("moved tab was not hydrated");
  return tab.id;
}
