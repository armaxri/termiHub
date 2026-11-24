/**
 * Tests for the run picker (#5818, slice 5): every target kind, the live
 * markers of the hand-picked list, the multi-terminal confirmation that names
 * every terminal and ignores Enter, the parallel toggle, and the remembered
 * last choice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

import { RunTargetsDialog, type RunPickerAutomation } from "./RunTargetsDialog";
import { resetRememberedRunTargetChoice } from "./runTargetChoice";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { LeafPanel, TerminalTab } from "@/types/terminal";

setupSettingsRegion();

let container: HTMLDivElement;
let root: Root;

const deploy: RunPickerAutomation = { id: "m1", name: "Deploy", stepCount: 2 };

function term(id: string, sessionId: string | null, connectionId?: string): TerminalTab {
  return {
    id,
    sessionId,
    title: `host-${id}`,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: "leaf-1",
    isActive: id === "a",
    connectionId,
  };
}

function seedTabs(tabs: TerminalTab[]) {
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs, activeTabId: tabs[0].id };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
const click = (testId: string) => act(() => q(testId).click());
const runButton = () => q("run-targets-run") as HTMLButtonElement;

function render(
  onRun = vi.fn(),
  automations: RunPickerAutomation[] = [deploy],
  open = true
): typeof onRun {
  act(() => {
    root.render(
      <RunTargetsDialog
        open={open}
        automations={automations}
        automationLabel="Macro"
        emptyText="No macros saved yet."
        onOpenChange={() => {}}
        onRun={onRun}
      />
    );
  });
  return onRun;
}

describe("RunTargetsDialog (#5818 slice 5)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    resetRememberedRunTargetChoice();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("defaults to this terminal and runs without a confirmation", () => {
    seedTabs([term("a", "s-a"), term("b", "s-b")]);
    const onRun = render();
    expect(document.body.textContent).toContain('Run "Deploy"');
    expect(q("run-targets-target-active").getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("This terminal (host-a)");
    expect(runButton().textContent).toBe("Run");
    click("run-targets-run");
    expect(onRun).toHaveBeenCalledWith("m1", ["a"], { parallel: true });
  });

  it("counts live terminals for this panel and all terminals", () => {
    seedTabs([term("a", "s-a"), term("b", "s-b"), term("c", null)]);
    render();
    expect(document.body.textContent).toContain("This panel (2)");
    expect(document.body.textContent).toContain("All terminals (2)");
    // Broadcast is off, so its option is not offered.
    expect(q("run-targets-target-broadcast")).toBeNull();
  });

  it("confirms a multi-terminal run by naming every terminal, ignoring Enter", () => {
    seedTabs([term("a", "s-a"), term("b", "s-b")]);
    const onRun = render();
    click("run-targets-target-all");
    expect(runButton().textContent).toBe("Run on 2 terminals…");
    click("run-targets-run");
    expect(onRun).not.toHaveBeenCalled();

    const list = q("run-targets-confirm-list");
    expect(list.textContent).toContain("host-a");
    expect(list.textContent).toContain("host-b");
    expect(q("run-targets-confirm-step").textContent).toContain(
      '"Deploy" will run on 2 terminals at the same time'
    );
    act(() => {
      q("run-targets-dialog").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(onRun).not.toHaveBeenCalled();

    expect(runButton().textContent).toBe("Run on 2 terminals");
    click("run-targets-run");
    expect(onRun).toHaveBeenCalledWith("m1", ["a", "b"], { parallel: true });
  });

  it("Back leaves the confirmation without running", () => {
    seedTabs([term("a", "s-a"), term("b", "s-b")]);
    const onRun = render();
    click("run-targets-target-all");
    click("run-targets-run");
    click("run-targets-cancel");
    expect(q("run-targets-confirm-step")).toBeNull();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("runs one after another when Run in parallel is turned off under More", () => {
    seedTabs([term("a", "s-a"), term("b", "s-b")]);
    const onRun = render();
    expect(q("run-targets-parallel")).toBeNull();
    click("run-targets-more");
    expect(q("run-targets-parallel").getAttribute("aria-checked")).toBe("true");
    click("run-targets-parallel");
    click("run-targets-target-all");
    click("run-targets-run");
    expect(q("run-targets-confirm-step").textContent).toContain("one after another");
    click("run-targets-run");
    expect(onRun).toHaveBeenCalledWith("m1", ["a", "b"], { parallel: false });
  });

  it("lists every terminal with its live state when picking terminals", () => {
    seedTabs([term("a", "s-a"), term("b", "s-b"), term("c", null)]);
    const onRun = render();
    click("run-targets-target-pick");
    const list = q("run-targets-terminal-list");
    expect(list.querySelectorAll('[aria-label="Live"]')).toHaveLength(2);
    expect(list.querySelectorAll('[aria-label="Not connected"]')).toHaveLength(1);
    // The active terminal starts picked; a not-connected one cannot be picked.
    expect(q("run-targets-terminal-a").getAttribute("aria-checked")).toBe("true");
    expect((q("run-targets-terminal-c") as HTMLButtonElement).disabled).toBe(true);
    click("run-targets-terminal-b");
    click("run-targets-run");
    click("run-targets-run");
    expect(onRun).toHaveBeenCalledWith("m1", ["a", "b"], { parallel: true });
  });

  it("runs on a saved broadcast group's live members", () => {
    seedTabs([term("a", "s-a", "c1"), term("b", "s-b", "c2"), term("c", "s-c", "c3")]);
    seedSettings({ broadcastGroups: [{ id: "g1", name: "web", connectionIds: ["c1", "c3"] }] });
    const onRun = render();
    click("run-targets-target-group");
    expect(q("run-targets-group").textContent).toContain("web (2)");
    click("run-targets-run");
    click("run-targets-run");
    expect(onRun).toHaveBeenCalledWith("m1", ["a", "c"], { parallel: true });
  });

  it("disables Run and says why when the choice reaches no live terminal", () => {
    seedTabs([term("a", "s-a", "c1")]);
    seedSettings({ broadcastGroups: [{ id: "g1", name: "db", connectionIds: ["c9"] }] });
    render();
    click("run-targets-target-group");
    expect(runButton().disabled).toBe(true);
    expect(q("run-targets-hint").textContent).toBe("No live terminals in this choice.");
  });

  it("disables Run for an automation without steps", () => {
    seedTabs([term("a", "s-a")]);
    render(vi.fn(), [{ id: "m0", name: "Empty", stepCount: 0 }]);
    expect(runButton().disabled).toBe(true);
    expect(q("run-targets-hint").textContent).toBe("This automation has no steps to run.");
  });

  it("offers a selector when there are several automations, and an empty state for none", () => {
    seedTabs([term("a", "s-a")]);
    render(vi.fn(), [deploy, { id: "m2", name: "Backup", stepCount: 1 }]);
    expect(q("run-targets-automation")).not.toBeNull();
    render(vi.fn(), []);
    expect(q("run-targets-empty").textContent).toContain("No macros saved yet.");
    expect(runButton().disabled).toBe(true);
  });

  it("opens on the last choice made", () => {
    seedTabs([term("a", "s-a"), term("b", "s-b")]);
    const onRun = render();
    click("run-targets-target-all");
    click("run-targets-run");
    click("run-targets-run");
    expect(onRun).toHaveBeenCalledTimes(1);

    render(onRun, [deploy], false);
    render(onRun, [deploy], true);
    expect(q("run-targets-target-all").getAttribute("aria-checked")).toBe("true");
  });
});
