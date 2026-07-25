import { describe, it, expect } from "vitest";
import { classifyWindowCloseSessions, windowCloseWouldLoseData } from "./windowClose";
import type { TerminalTab } from "@/types/terminal";

/** Build a minimal terminal tab for classification tests. */
function tab(overrides: Partial<TerminalTab>): TerminalTab {
  return {
    id: "tab-1",
    sessionId: "sess-1",
    title: "shell",
    connectionType: "local",
    contentType: "terminal",
    config: {} as TerminalTab["config"],
    panelId: "panel-1",
    isActive: true,
    ...overrides,
  };
}

describe("classifyWindowCloseSessions (#1903)", () => {
  it("ignores tabs with no backend session", () => {
    const rows = classifyWindowCloseSessions([
      tab({ id: "t1", sessionId: null }),
      tab({ id: "t2", sessionId: "sess-2" }),
    ]);
    expect(rows.map((r) => r.tabId)).toEqual(["t2"]);
  });

  it("classifies a persistent tab as detach and a non-persistent tab as terminate", () => {
    const rows = classifyWindowCloseSessions([
      tab({ id: "t1", sessionId: "s1", persistentConnectionId: "conn-a" }),
      tab({ id: "t2", sessionId: "s2" }),
    ]);
    expect(rows.find((r) => r.tabId === "t1")?.outcome).toBe("detach");
    expect(rows.find((r) => r.tabId === "t2")?.outcome).toBe("terminate");
  });

  it("carries display fields (title, connection type, content type) for each row", () => {
    const [row] = classifyWindowCloseSessions([
      tab({ id: "t1", sessionId: "s1", title: "server-1", connectionType: "ssh" }),
    ]);
    expect(row).toMatchObject({
      tabId: "t1",
      sessionId: "s1",
      title: "server-1",
      connectionType: "ssh",
      contentType: "terminal",
    });
  });
});

describe("windowCloseWouldLoseData (#1903)", () => {
  it("is false when there are no sessions (empty window)", () => {
    expect(windowCloseWouldLoseData([])).toBe(false);
  });

  it("is false when every session detaches (all persistent)", () => {
    const rows = classifyWindowCloseSessions([
      tab({ id: "t1", sessionId: "s1", persistentConnectionId: "a" }),
      tab({ id: "t2", sessionId: "s2", persistentConnectionId: "b" }),
    ]);
    expect(windowCloseWouldLoseData(rows)).toBe(false);
  });

  it("is true when at least one session would be terminated", () => {
    const rows = classifyWindowCloseSessions([
      tab({ id: "t1", sessionId: "s1", persistentConnectionId: "a" }),
      tab({ id: "t2", sessionId: "s2" }),
    ]);
    expect(windowCloseWouldLoseData(rows)).toBe(true);
  });
});
