/**
 * Unit tests for the #2205 PR-A render-cut helpers in `sessionBridge`: the
 * faithful-mirror gate that lets the terminal lifecycle readers source their
 * connect / reconnect / disconnect-error status from the projected
 * `session-lifecycle` region, with an `appStore` fallback per field / key.
 *
 * The contract under test: when the region mirrors the local slice the effective
 * value is sourced from the region; otherwise it is the local slice verbatim, so
 * the rendered output is byte-identical to the pre-cut path (and identical when the
 * render flag is off).
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
  it("sources true from a mirroring projected connecting status", () => {
    expect(effectiveConnecting(true, life("connecting"))).toBe(true);
  });

  it("falls back to the local bool when the region does not mirror", () => {
    // Region says connecting, local says not — mismatch → local wins.
    expect(effectiveConnecting(false, life("connecting"))).toBe(false);
    // Local says connecting, region has no such session — local wins.
    expect(effectiveConnecting(true, undefined)).toBe(true);
    // Region reports a different status — local wins.
    expect(effectiveConnecting(true, life("connected"))).toBe(true);
  });

  it("returns the local bool verbatim when the render cut is off", () => {
    setSessionRenderFromProjectionEnabled(false);
    expect(effectiveConnecting(true, life("connected"))).toBe(true);
    expect(effectiveConnecting(false, life("connecting"))).toBe(false);
  });
});

describe("effectiveReconnecting", () => {
  it("sources true from a mirroring projected reconnecting status", () => {
    expect(effectiveReconnecting(true, life("reconnecting"))).toBe(true);
  });

  it("falls back to the local bool when the region does not mirror", () => {
    expect(effectiveReconnecting(false, life("reconnecting"))).toBe(false);
    expect(effectiveReconnecting(true, life("connected"))).toBe(true);
    expect(effectiveReconnecting(true, undefined)).toBe(true);
  });
});

describe("effectiveDisconnectError", () => {
  it("sources the error from a mirroring failed status", () => {
    expect(effectiveDisconnectError("boom", life("failed", "boom"))).toBe("boom");
  });

  it("falls back to the local error when the strings diverge", () => {
    expect(effectiveDisconnectError("boom", life("failed", "different"))).toBe("boom");
    // Region reports no error (deferred server fold #2439) but local has one.
    expect(effectiveDisconnectError("boom", life("connected"))).toBe("boom");
    expect(effectiveDisconnectError("boom", undefined)).toBe("boom");
  });

  it("returns undefined when neither has an error", () => {
    expect(effectiveDisconnectError(undefined, life("connected"))).toBeUndefined();
  });
});

describe("effectiveReconnectTriggerError (#2442)", () => {
  it("sources the trigger error from a mirroring region reconnectError field", () => {
    expect(effectiveReconnectTriggerError("reset", withTrigger("reconnecting", "reset"))).toBe(
      "reset"
    );
    // Read directly off the field, independent of status.
    expect(effectiveReconnectTriggerError("reset", withTrigger("connected", "reset"))).toBe(
      "reset"
    );
  });

  it("falls back to the local error when the strings diverge or the region is silent", () => {
    expect(effectiveReconnectTriggerError("reset", withTrigger("reconnecting", "different"))).toBe(
      "reset"
    );
    // Region has no reconnectError (not yet mirrored) but local does — local wins.
    expect(effectiveReconnectTriggerError("reset", withTrigger("reconnecting"))).toBe("reset");
    expect(effectiveReconnectTriggerError("reset", undefined)).toBe("reset");
  });

  it("returns undefined when neither carries a trigger error", () => {
    expect(effectiveReconnectTriggerError(undefined, withTrigger("reconnecting"))).toBeUndefined();
  });

  it("returns the local value verbatim when the render cut is off", () => {
    setSessionRenderFromProjectionEnabled(false);
    // A divergent region value must be ignored with the flag off.
    expect(effectiveReconnectTriggerError("reset", withTrigger("reconnecting", "other"))).toBe(
      "reset"
    );
  });
});

describe("effective*Map helpers", () => {
  it("produce byte-identical maps to the local slice (sourced through the gate)", () => {
    const view: Record<string, ProjectedSessionLifecycle> = {
      a: life("connecting"),
      b: life("reconnecting"),
      c: life("failed", "nope"),
    };
    expect(effectiveConnectingMap({ a: true }, view)).toEqual({ a: true });
    expect(effectiveReconnectingMap({ b: true }, view)).toEqual({ b: true });
    expect(effectiveDisconnectErrorMap({ c: "nope" }, view)).toEqual({ c: "nope" });
  });

  it("never adds a key the local map lacks, even if the region reports one", () => {
    const view: Record<string, ProjectedSessionLifecycle> = { ghost: life("connecting") };
    expect(effectiveConnectingMap({}, view)).toEqual({});
    expect(effectiveReconnectingMap({}, { ghost: life("reconnecting") })).toEqual({});
  });

  it("keeps a local error key whose region entry diverges (fallback)", () => {
    const view: Record<string, ProjectedSessionLifecycle> = { c: life("failed", "stale") };
    expect(effectiveDisconnectErrorMap({ c: "fresh" }, view)).toEqual({ c: "fresh" });
  });

  it("returns the local map reference verbatim when the render cut is off", () => {
    setSessionRenderFromProjectionEnabled(false);
    const connecting = { a: true };
    expect(effectiveConnectingMap(connecting, {})).toBe(connecting);
  });
});
