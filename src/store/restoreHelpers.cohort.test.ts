import { describe, expect, it } from "vitest";
import type { TabGroup, TerminalTab } from "@/types/terminal";
import { collectRestoreCohort } from "./restoreHelpers";

function terminalTab(id: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    sessionId: null,
    title: id,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "p1",
    isActive: false,
    ...extra,
  };
}

describe("collectRestoreCohort", () => {
  it("does not wait on a tab held for confirming an imported inline config (#4434)", () => {
    const groups: TabGroup[] = [
      {
        id: "g1",
        name: "Main",
        activePanelId: "p1",
        rootPanel: {
          type: "leaf",
          id: "p1",
          activeTabId: "a",
          tabs: [
            terminalTab("a"),
            terminalTab("b", { pendingImportedConnection: true }),
            terminalTab("c", { pendingImportedCommand: "ls" }),
          ],
        },
      },
    ];
    expect(collectRestoreCohort(groups)).toEqual({ pendingTabIds: ["a", "c"], preFailedCount: 0 });
  });
});
