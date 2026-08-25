/**
 * Unit tests for the terminal lifecycle readers in `sessionBridge`. Since #2205
 * PR-B removed the `appStore` reconnect engine, the connect / reconnect /
 * reconnect-trigger status is sourced **purely** from the projected
 * `session-lifecycle` region — no local slice, no faithful-mirror gate. The
 * disconnect **error** keeps its per-client `appStore` slice, so
 * `effectiveDisconnectError` still blends the two under the render flag.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  effectiveConnecting,
  effectiveConnectingMap,
  effectiveDisconnectError,
  effectiveDisconnectErrorMap,
  effectiveReconnecting,
  effectiveReconnectingMap,
  effectiveReconnectTriggerError,
  setSessionRenderFromProjectionEnabled,
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

afterEach(() => {
  setSessionRenderFromProjectionEnabled(null);
});

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

describe("effectiveDisconnectError", () => {
  it("sources the error from a mirroring failed status", () => {
    expect(effectiveDisconnectError("boom", life("failed", "boom"))).toBe("boom");
  });

  it("falls back to the local error when the strings diverge", () => {
    expect(effectiveDisconnectError("boom", life("failed", "different"))).toBe("boom");
    // Region reports no error but local has one.
    expect(effectiveDisconnectError("boom", life("connected"))).toBe("boom");
    expect(effectiveDisconnectError("boom", undefined)).toBe("boom");
  });

  it("returns undefined when neither has an error", () => {
    expect(effectiveDisconnectError(undefined, life("connected"))).toBeUndefined();
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

  it("keep the disconnect-error map on its per-client slice (region blend under the flag)", () => {
    const view: Record<string, ProjectedSessionLifecycle> = { c: life("failed", "stale") };
    // Local diverges from the region → local wins (the disconnect error is not
    // part of the removed engine, so it keeps its appStore fallback).
    expect(effectiveDisconnectErrorMap({ c: "fresh" }, view)).toEqual({ c: "fresh" });
  });
});
