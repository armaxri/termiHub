import { describe, it, expect } from "vitest";
import {
  persistentAttachedTabTitles,
  formatAttachedTabsTooltip,
  type PersistentTabTitlesState,
} from "./persistentTabTitles";
import type { PanelNode, TerminalTab } from "@/types/terminal";
import type { PersistentSessionEntry } from "@/types/connection";

function tab(id: string, title: string): TerminalTab {
  return {
    id,
    sessionId: "s",
    title,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: "p",
    isActive: false,
  };
}

function leaf(id: string, tabs: TerminalTab[]): PanelNode {
  return { type: "leaf", id, tabs, activeTabId: tabs[0]?.id ?? null };
}

function entry(attachedTabIds: string[]): PersistentSessionEntry {
  return { connectionId: "c", sessionId: "s", state: "attached", attachedTabIds };
}

function state(
  rootPanel: PanelNode,
  persistentSessions: Record<string, PersistentSessionEntry>,
  otherGroups: { id: string; rootPanel: PanelNode }[] = []
): PersistentTabTitlesState {
  return {
    rootPanel,
    activeTabGroupId: "active",
    tabGroups: [{ id: "active", rootPanel }, ...otherGroups],
    persistentSessions,
  };
}

describe("persistentAttachedTabTitles", () => {
  it("returns [] for an unknown session", () => {
    const s = state(leaf("p", []), {});
    expect(persistentAttachedTabTitles(s, "missing")).toEqual([]);
  });

  it("returns [] when the session has no attached tabs", () => {
    const s = state(leaf("p", [tab("t1", "Shell")]), { c: entry([]) });
    expect(persistentAttachedTabTitles(s, "c")).toEqual([]);
  });

  it("resolves titles in attach order", () => {
    const s = state(leaf("p", [tab("t1", "Shell"), tab("t2", "Logs")]), {
      c: entry(["t2", "t1"]),
    });
    expect(persistentAttachedTabTitles(s, "c")).toEqual(["Logs", "Shell"]);
  });

  it("drops attached ids that no longer map to a tab", () => {
    const s = state(leaf("p", [tab("t1", "Shell")]), { c: entry(["t1", "gone"]) });
    expect(persistentAttachedTabTitles(s, "c")).toEqual(["Shell"]);
  });

  it("resolves tabs living in a non-active tab group", () => {
    const active = leaf("p-active", []);
    const background = leaf("p-bg", [tab("t9", "Background")]);
    const s = state(active, { c: entry(["t9"]) }, [{ id: "bg", rootPanel: background }]);
    expect(persistentAttachedTabTitles(s, "c")).toEqual(["Background"]);
  });
});

describe("formatAttachedTabsTooltip", () => {
  it("renders a count header and a bullet per tab name", () => {
    expect(formatAttachedTabsTooltip(["Shell", "Logs"])).toBe("2 tabs attached:\n• Shell\n• Logs");
  });
});
