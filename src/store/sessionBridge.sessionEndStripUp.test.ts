/**
 * `sessionEndStripUp` (#5955): Enter in a dead terminal runs the session-end
 * strip's Restart / Reconnect only while that strip is the notice on screen.
 */
import { describe, it, expect } from "vitest";
import { sessionEndStripUp, type ProjectedSessionLifecycle } from "./sessionBridge";

const IDLE = { phase: "idle", attempt: 0, delayMs: 0 } as ProjectedSessionLifecycle["reconnect"];

function life(overrides: Partial<ProjectedSessionLifecycle>): ProjectedSessionLifecycle {
  return { status: "disconnected", reconnect: IDLE, ...overrides };
}

describe("sessionEndStripUp (#5955)", () => {
  it("is up for a session that ended with a recorded exit", () => {
    expect(sessionEndStripUp(life({ exit: { code: 3, reason: "dropped" } }))).toBe(true);
    expect(sessionEndStripUp(life({ exit: { code: 0, reason: "clean" } }))).toBe(true);
  });

  it("is down without a session or an exit", () => {
    expect(sessionEndStripUp(undefined)).toBe(false);
    expect(sessionEndStripUp(life({}))).toBe(false);
  });

  it("is down while another notice owns the tab", () => {
    const exit = { code: null, reason: "dropped" } as const;
    expect(sessionEndStripUp(life({ exit, status: "reconnecting" }))).toBe(false);
    expect(sessionEndStripUp(life({ exit, status: "failed", error: "gave up" }))).toBe(false);
    expect(sessionEndStripUp(life({ exit, status: "sessionLost" }))).toBe(false);
  });
});
