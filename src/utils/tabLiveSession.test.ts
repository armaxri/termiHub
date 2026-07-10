import { describe, it, expect } from "vitest";
import { tabHasLiveSession, countLiveSessions, LiveSessionMaps } from "./tabLiveSession";
import { TerminalTab } from "@/types/terminal";

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "tab-1",
    sessionId: "sess-1",
    title: "Terminal",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "panel-1",
    isActive: true,
    ...overrides,
  };
}

const emptyMaps: LiveSessionMaps = { terminalExitedTabs: {}, terminalSpawnErrors: {} };

describe("tabHasLiveSession", () => {
  it("returns true for a live terminal tab", () => {
    expect(tabHasLiveSession(makeTab(), emptyMaps)).toBe(true);
  });

  it("returns false for non-terminal tabs", () => {
    expect(tabHasLiveSession(makeTab({ contentType: "editor" }), emptyMaps)).toBe(false);
    expect(tabHasLiveSession(makeTab({ contentType: "settings" }), emptyMaps)).toBe(false);
  });

  it("returns false when the session has exited", () => {
    expect(
      tabHasLiveSession(makeTab(), { ...emptyMaps, terminalExitedTabs: { "tab-1": true } })
    ).toBe(false);
  });

  it("returns false when the terminal failed to spawn", () => {
    expect(
      tabHasLiveSession(makeTab(), { ...emptyMaps, terminalSpawnErrors: { "tab-1": "boom" } })
    ).toBe(false);
  });

  it("returns false for a persistent-session-attached tab (closing only detaches)", () => {
    expect(tabHasLiveSession(makeTab({ persistentConnectionId: "conn-9" }), emptyMaps)).toBe(false);
  });
});

describe("countLiveSessions", () => {
  it("counts only the live terminal tabs", () => {
    const tabs = [
      makeTab({ id: "a" }),
      makeTab({ id: "b" }),
      makeTab({ id: "c", contentType: "editor" }),
      makeTab({ id: "d" }),
    ];
    const maps: LiveSessionMaps = { terminalExitedTabs: { d: true }, terminalSpawnErrors: {} };
    expect(countLiveSessions(tabs, maps)).toBe(2);
  });

  it("returns 0 for an empty list", () => {
    expect(countLiveSessions([], emptyMaps)).toBe(0);
  });
});
