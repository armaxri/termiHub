import { describe, it, expect, beforeEach, vi } from "vitest";

// #6161: switch to tab N, reopen the last closed tab (also from panel and tab
// group closes, without re-running what the tab ran at its start, #6065), and
// close others / close to the right through the close guard (#5189).

vi.mock("@/services/api", () => ({
  closeTerminal: vi.fn(() => Promise.resolve()),
  detachPersistentTab: vi.fn(() => Promise.resolve()),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { useAppStore } from "./appStore";
import { layoutState } from "@/test/layoutState";
import { getAllLeaves } from "@/utils/panelTree";
import { CONTEXT_COMMANDS } from "@/services/contextCommands";
import {
  CLOSED_TAB_LIMIT,
  hasClosedTab,
  resetClosedTabs,
  takeLastClosedTab,
} from "@/utils/closedTabStack";
import { closeTabsGuarded, tabsToClose } from "@/utils/closeTabs";

function leaf() {
  return getAllLeaves(layoutState().rootPanel)[0];
}
function titles(): string[] {
  return leaf().tabs.map((t) => t.title);
}
function open(title: string, opts: { sessionId?: string; initialCommand?: string } = {}) {
  return useAppStore.getState().addTab(
    title,
    "local",
    {
      type: "local",
      config: opts.initialCommand ? { shell: "zsh", initialCommand: opts.initialCommand } : {},
    },
    { contentType: "terminal", sessionId: opts.sessionId }
  );
}
const command = (id: string) => CONTEXT_COMMANDS[id];
/** Tabs whose shell failed to start: closing them ends no live session. */
function ended(...tabIds: string[]) {
  const errors = { ...useAppStore.getState().terminalSpawnErrors };
  for (const id of tabIds) errors[id] = "failed to start";
  useAppStore.setState({ terminalSpawnErrors: errors });
}

describe("tab shortcuts (#6161)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    resetClosedTabs();
  });

  describe("switch to tab N", () => {
    it("selects the Nth tab of the active panel, and 9 the last", () => {
      ["one", "two", "three"].forEach((t) => open(t));
      command("switch-to-tab-2").run();
      expect(leaf().activeTabId).toBe(leaf().tabs[1].id);
      command("switch-to-tab-9").run();
      expect(leaf().activeTabId).toBe(leaf().tabs[2].id);
    });

    it("is not offered past the panel's last tab", () => {
      ["one", "two"].forEach((t) => open(t));
      expect(command("switch-to-tab-2").isAvailable()).toBe(true);
      expect(command("switch-to-tab-3").isAvailable()).toBe(false);
      expect(command("switch-to-tab-9").isAvailable()).toBe(true);
    });
  });

  describe("reopen closed tab", () => {
    it("reopens the last closed tab, without what it ran at its start (#6065)", () => {
      open("keep");
      const id = open("build", { initialCommand: "make deploy" });
      useAppStore.getState().closeTab(id, leaf().id);
      expect(command("reopen-closed-tab").isAvailable()).toBe(true);
      command("reopen-closed-tab").run();
      expect(titles()).toEqual(["keep", "build"]);
      const reopened = leaf().tabs[1];
      expect(reopened.config.config).not.toHaveProperty("initialCommand");
      expect(reopened.config.config).toHaveProperty("shell", "zsh");
      expect(command("reopen-closed-tab").isAvailable()).toBe(false);
    });

    it("keeps the tabs a tab group close took", () => {
      open("a");
      useAppStore.getState().addTabGroup();
      open("b");
      open("c");
      useAppStore.getState().closeTabGroup(layoutState().activeTabGroupId!);
      expect(takeLastClosedTab()?.title).toBe("c");
      expect(takeLastClosedTab()?.title).toBe("b");
    });

    it("remembers at most a limited number of closed tabs", () => {
      open("keep");
      for (let i = 0; i < CLOSED_TAB_LIMIT + 5; i++) {
        const id = open(`t${i}`);
        useAppStore.getState().closeTab(id, leaf().id);
      }
      let count = 0;
      while (hasClosedTab()) {
        takeLastClosedTab();
        count++;
      }
      expect(count).toBe(CLOSED_TAB_LIMIT);
    });
  });

  describe("close others / close to the right", () => {
    it("picks the tabs to close", () => {
      const ids = ["a", "b", "c", "d"].map((t) => open(t));
      expect(tabsToClose(leaf(), ids[1], "others").map((t) => t.title)).toEqual(["a", "c", "d"]);
      expect(tabsToClose(leaf(), ids[1], "right").map((t) => t.title)).toEqual(["c", "d"]);
    });

    it("closes at once when no session would end, and keeps them for Reopen", () => {
      const ids = ["a", "b", "c"].map((t) => open(t));
      ended(ids[1], ids[2]);
      closeTabsGuarded(leaf().id, tabsToClose(leaf(), ids[0], "right"));
      expect(titles()).toEqual(["a"]);
      expect(hasClosedTab()).toBe(true);
    });

    it("asks first when a live session would end", () => {
      const ids = [open("a"), open("b", { sessionId: "s-b" }), open("c")];
      ended(ids[2]); // c's shell failed to start: only b's session would end
      closeTabsGuarded(leaf().id, tabsToClose(leaf(), ids[0], "others"));
      expect(titles()).toEqual(["a", "b", "c"]);
      const request = useAppStore.getState().pendingSessionCloseConfirm;
      expect(request).toMatchObject({ kind: "tabs", liveCount: 1, tabCount: 2 });
    });
  });
});
