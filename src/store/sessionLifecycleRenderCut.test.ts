/**
 * Unit tests for the terminal lifecycle readers in `sessionBridge`. The connect /
 * reconnect / reconnect-trigger status AND the disconnect error are all sourced
 * **purely** from the projected `session-lifecycle` region — no local slice, no
 * faithful-mirror gate (#2205 PR-B removed the reconnect engine; #2625 deleted the
 * `terminalDisconnectErrors` slice, so `effectiveDisconnectError` is region-only).
 */

import { describe, expect, it } from "vitest";

import {
  effectiveConnecting,
  effectiveConnectingMap,
  effectiveDisconnectError,
  effectiveDisconnectErrorMap,
  effectiveReconnecting,
  effectiveReconnectingMap,
  effectiveReconnectTriggerError,
  type ProjectedSessionLifecycle,
} from "@/store/sessionBridge";

const idle = { phase: "idle" as const, attempt: 0, delayMs: 0 };

function life(
  status: ProjectedSessionLifecycle["status"],
  error?: string
): ProjectedSessionLifecycle {
  return { status, reconnect: idle, ...(error !== undefined ? { error } : {}) };
}

/** A projected lifecycle carrying a region-owned reconnect-trigger cause (#2442). */
function withTrigger(
  status: ProjectedSessionLifecycle["status"],
  reconnectError?: string
): ProjectedSessionLifecycle {
  return { status, reconnect: idle, ...(reconnectError !== undefined ? { reconnectError } : {}) };
}

describe("effectiveConnecting", () => {
  it("is true only for a projected connecting status", () => {
    expect(effectiveConnecting(life("connecting"))).toBe(true);
    expect(effectiveConnecting(life("connected"))).toBe(false);
    expect(effectiveConnecting(life("reconnecting"))).toBe(false);
    expect(effectiveConnecting(undefined)).toBe(false);
  });
});

describe("effectiveReconnecting", () => {
  it("is true only for a projected reconnecting status", () => {
    expect(effectiveReconnecting(life("reconnecting"))).toBe(true);
    expect(effectiveReconnecting(life("connected"))).toBe(false);
    expect(effectiveReconnecting(life("connecting"))).toBe(false);
    expect(effectiveReconnecting(undefined)).toBe(false);
  });
});

describe("effectiveDisconnectError (#2625 region-only)", () => {
  it("sources the error from the region's failed status", () => {
    expect(effectiveDisconnectError(life("failed", "boom"))).toBe("boom");
  });

  it("returns undefined when the region is not in a failed status", () => {
    expect(effectiveDisconnectError(life("connected"))).toBeUndefined();
    expect(effectiveDisconnectError(life("reconnecting"))).toBeUndefined();
    expect(effectiveDisconnectError(undefined)).toBeUndefined();
  });
});

describe("effectiveReconnectTriggerError (#2442)", () => {
  it("sources the trigger error straight from the region reconnectError field", () => {
    expect(effectiveReconnectTriggerError(withTrigger("reconnecting", "reset"))).toBe("reset");
    // Read directly off the field, independent of status.
    expect(effectiveReconnectTriggerError(withTrigger("connected", "reset"))).toBe("reset");
  });

  it("returns undefined when the region carries no trigger error", () => {
    expect(effectiveReconnectTriggerError(withTrigger("reconnecting"))).toBeUndefined();
    expect(effectiveReconnectTriggerError(undefined)).toBeUndefined();
  });
});

describe("effective*Map helpers", () => {
  it("build the connect / reconnect maps purely from the region view", () => {
    const view: Record<string, ProjectedSessionLifecycle> = {
      a: life("connecting"),
      b: life("reconnecting"),
      c: life("failed", "nope"),
    };
    expect(effectiveConnectingMap(view)).toEqual({ a: true });
    expect(effectiveReconnectingMap(view)).toEqual({ b: true });
  });

  it("include every region key with the matching status (no local map to gate on)", () => {
    expect(effectiveConnectingMap({ ghost: life("connecting") })).toEqual({ ghost: true });
    expect(effectiveReconnectingMap({ ghost: life("reconnecting") })).toEqual({ ghost: true });
    expect(effectiveConnectingMap({})).toEqual({});
  });

  it("build the disconnect-error map purely from the region view (#2625)", () => {
    const view: Record<string, ProjectedSessionLifecycle> = {
      a: life("connecting"),
      c: life("failed", "boom"),
      d: life("connected"),
    };
    expect(effectiveDisconnectErrorMap(view)).toEqual({ c: "boom" });
  });
});
