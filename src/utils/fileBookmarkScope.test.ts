/** Bookmark scope derivation (PROD-007, #3558). */
import { describe, it, expect } from "vitest";
import { fileBookmarkScope } from "./fileBookmarkScope";
import type { TerminalTab } from "@/types/terminal";

function tab(partial: Partial<TerminalTab>): TerminalTab {
  return {
    id: "t1",
    sessionId: "s1",
    title: "tab",
    connectionType: "ssh",
    config: { type: "ssh", config: {} },
    ...partial,
  } as TerminalTab;
}

describe("fileBookmarkScope", () => {
  it("scopes every local browser to the shared local scope", () => {
    expect(fileBookmarkScope("local", null)).toBe("local");
    expect(fileBookmarkScope("local", tab({ connectionId: "c1" }))).toBe("local");
  });

  it("has no scope while the browser is idle", () => {
    expect(fileBookmarkScope("none", tab({ connectionId: "c1" }))).toBeNull();
  });

  it("uses the saved connection id for a remote session", () => {
    expect(fileBookmarkScope("session", tab({ connectionId: "c1" }))).toBe("connection:c1");
  });

  it("falls back to type + user@host:port for an unsaved connection", () => {
    const t = tab({
      connectionType: "ssh",
      config: { type: "ssh", config: { host: "Box.example", username: "ops", port: 2222 } },
    });
    expect(fileBookmarkScope("session", t)).toBe("host:ssh:ops@box.example:2222");
  });

  it("scopes an agent session by agent and session type", () => {
    const t = tab({
      connectionType: "remote-session",
      config: { type: "remote-session", config: { agentId: "ag1", sessionType: "local" } },
    });
    expect(fileBookmarkScope("session", t)).toBe("agent:ag1:local");
  });

  it("has no scope when nothing identifies the remote end", () => {
    expect(fileBookmarkScope("session", tab({}))).toBeNull();
    expect(fileBookmarkScope("session", null)).toBeNull();
  });
});
