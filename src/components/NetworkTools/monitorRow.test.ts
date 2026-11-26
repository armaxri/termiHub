/** What a monitor row says on an agent (#6052) and where it checks from (#6039). */
import { describe, expect, it } from "vitest";
import type { HttpMonitorState } from "@/types/network";
import { monitorServiceState } from "@/utils/serviceState";
import { monitorRowMarker, monitorRowTooltip } from "./monitorRow";

const NOW = 1_700_000_100_000;

function monitor(over: Partial<HttpMonitorState> = {}): HttpMonitorState {
  return {
    config: {
      id: "m",
      url: "https://m.example/health",
      intervalMs: 30_000,
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 5_000,
    },
    running: true,
    paused: false,
    lastResult: { monitorId: "m", statusCode: 200, latencyMs: 3, ok: true, timestampMs: NOW },
    ...over,
  };
}

describe("a monitor on an agent reads like a service (#6052)", () => {
  it.each([
    ["notReachable", "Not reachable"],
    ["stopping", "Stopping"],
    ["starting", "Starting"],
    ["error", "Error"],
  ] as const)("%s: says so on its row, not running", (status, word) => {
    const row = monitorRowMarker(monitor({ status, running: false }), NOW);
    expect(row).toEqual({ kind: "state", label: word });
  });

  it("says why, when it knows", () => {
    const why = "Its agent is offline. It may still run there; termiHub cannot tell.";
    expect(monitorRowMarker(monitor({ status: "notReachable", reason: why }), NOW)?.label).toBe(
      why
    );
  });

  it("a running or stopped one keeps its own markers", () => {
    expect(monitorRowMarker(monitor({ status: "running" }), NOW)).toBeNull();
    expect(monitorRowMarker(monitor({ status: "stopped", running: false }), NOW)?.kind).toBe(
      "stopped"
    );
  });

  it("an older backend without a status reads from its running flag", () => {
    expect(monitorServiceState({ running: true })).toBe("running");
    expect(monitorServiceState({ running: false })).toBe("stopped");
    expect(monitorServiceState({ running: false, status: "notReachable" })).toBe("notReachable");
  });
});

describe("where it checks from (#6039)", () => {
  it("names the agent in the tooltip, and nothing for this computer", () => {
    expect(monitorRowTooltip(monitor(), NOW, "Edge box")).toContain("Checks from Edge box");
    expect(monitorRowTooltip(monitor(), NOW).join(" ")).not.toContain("Checks from");
    const why = "Its agent is offline.";
    expect(monitorRowTooltip(monitor({ reason: why }), NOW, "Edge box")).toContain(why);
  });
});
