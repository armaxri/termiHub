import { describe, it, expect } from "vitest";
import { parseAgentSemver, resolveAgentUpdateState, summarizeAgentUpdates } from "./agentVersion";

describe("parseAgentSemver", () => {
  it("parses a plain major.minor.patch version", () => {
    expect(parseAgentSemver("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseAgentSemver("2.15.3")).toEqual({ major: 2, minor: 15, patch: 3 });
  });

  it("strips a -prerelease or +build suffix (dev builds)", () => {
    expect(parseAgentSemver("0.1.0-dev")).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseAgentSemver("1.2.3+abc123")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("returns null for unparseable versions", () => {
    expect(parseAgentSemver("invalid")).toBeNull();
    expect(parseAgentSemver("1.0")).toBeNull();
    expect(parseAgentSemver("1.0.0.0")).toBeNull();
    expect(parseAgentSemver("")).toBeNull();
    expect(parseAgentSemver("v1.0.0")).toBeNull();
  });
});

describe("resolveAgentUpdateState", () => {
  // ── up-to-date (Compatible) ─────────────────────────────────────────
  it("returns up-to-date for an exact match", () => {
    expect(resolveAgentUpdateState("0.1.0", "0.1.0")).toBe("up-to-date");
  });

  it("returns up-to-date when the agent minor is newer", () => {
    expect(resolveAgentUpdateState("0.2.0", "0.1.0")).toBe("up-to-date");
    expect(resolveAgentUpdateState("0.5.0", "0.1.0")).toBe("up-to-date");
  });

  it("ignores the patch version (up-to-date)", () => {
    expect(resolveAgentUpdateState("0.1.5", "0.1.0")).toBe("up-to-date");
  });

  it("treats a -dev suffix as its base version (up-to-date)", () => {
    expect(resolveAgentUpdateState("0.1.0", "0.1.0-dev")).toBe("up-to-date");
    expect(resolveAgentUpdateState("0.1.0-dev", "0.1.0")).toBe("up-to-date");
  });

  // ── update-available (AgentTooOld) ──────────────────────────────────
  it("returns update-available when the agent minor is older", () => {
    expect(resolveAgentUpdateState("0.1.0", "0.2.0")).toBe("update-available");
  });

  // ── incompatible (MajorMismatch / InvalidVersion) ───────────────────
  it("returns incompatible on a major mismatch", () => {
    expect(resolveAgentUpdateState("1.0.0", "0.1.0")).toBe("incompatible");
    expect(resolveAgentUpdateState("0.1.0", "1.0.0")).toBe("incompatible");
  });

  it("returns incompatible for an unparseable but present agent version", () => {
    expect(resolveAgentUpdateState("garbage", "0.1.0")).toBe("incompatible");
  });

  // ── unknown (no version reported) ───────────────────────────────────
  it("returns unknown when no agent version is known", () => {
    expect(resolveAgentUpdateState("", "0.1.0")).toBe("unknown");
    expect(resolveAgentUpdateState(undefined, "0.1.0")).toBe("unknown");
  });

  it("returns unknown while the desktop version is not yet loaded", () => {
    // Avoids flashing "incompatible" during the async app-info fetch.
    expect(resolveAgentUpdateState("0.1.0", "")).toBe("unknown");
    expect(resolveAgentUpdateState("0.1.0", undefined)).toBe("unknown");
    expect(resolveAgentUpdateState("0.1.0", null)).toBe("unknown");
  });
});

describe("summarizeAgentUpdates", () => {
  const agent = (connectionState: string, agentVersion?: string) => ({
    connectionState,
    capabilities: agentVersion ? { agentVersion } : undefined,
  });

  it("counts only connected agents", () => {
    const summary = summarizeAgentUpdates(
      [
        agent("connected", "0.1.0"),
        agent("connecting", "0.1.0"),
        agent("disconnected"),
        agent("connected", "0.1.0"),
      ],
      "0.1.0"
    );
    expect(summary.connectedCount).toBe(2);
  });

  it("counts connected agents that have an update available", () => {
    const summary = summarizeAgentUpdates(
      [
        agent("connected", "0.1.0"), // update-available vs 0.2.0
        agent("connected", "0.2.0"), // up-to-date
        agent("connected", "1.0.0"), // incompatible (not counted as update)
        agent("connecting", "0.1.0"), // not connected
      ],
      "0.2.0"
    );
    expect(summary.connectedCount).toBe(3);
    expect(summary.updatesAvailable).toBe(1);
  });

  it("reports zero updates while the desktop version is unknown", () => {
    const summary = summarizeAgentUpdates([agent("connected", "0.1.0")], null);
    expect(summary.connectedCount).toBe(1);
    expect(summary.updatesAvailable).toBe(0);
  });
});
