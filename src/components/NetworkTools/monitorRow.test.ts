/** What a monitor row says on an agent (#6052) and where it checks from (#6039). */
import { describe, expect, it } from "vitest";
import type { HttpMonitorState } from "@/types/network";
import { monitorServiceState } from "@/utils/serviceState";
import {
  monitorNextSteps,
  monitorRowMarker,
  monitorRowTooltip,
  monitorRunActions,
} from "./monitorRow";

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

  it("the marker is the state word; the reason has its own line (F-009)", () => {
    const why = "Its agent is offline. It may still run there; termiHub cannot tell.";
    expect(monitorRowMarker(monitor({ status: "notReachable", reason: why }), NOW)?.label).toBe(
      "Not reachable"
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

describe("what a row offers in each state (F-009)", () => {
  const offers = (
    over: Partial<HttpMonitorState>,
    host: Parameters<typeof monitorRunActions>[1] = { kind: "thisComputer" }
  ) => monitorRunActions(monitor(over), host);

  it("a running one pauses and stops; a paused one resumes and stops", () => {
    expect(offers({ status: "running" })).toEqual({ pause: true, resume: false, stop: true });
    expect(offers({ status: "running", paused: true })).toEqual({
      pause: false,
      resume: true,
      stop: true,
    });
  });

  it("a stopped or failed one starts again", () => {
    expect(offers({ status: "stopped", running: false })).toEqual({
      pause: false,
      resume: true,
      stop: false,
    });
    expect(offers({ status: "error", running: false }).resume).toBe(true);
  });

  it("stopping offers nothing to run, not reachable only Stop", () => {
    expect(offers({ status: "stopping" })).toEqual({ pause: false, resume: false, stop: false });
    expect(offers({ status: "notReachable" }, { kind: "agent", agentId: "a" })).toEqual({
      pause: false,
      resume: false,
      stop: true,
    });
  });

  it("one whose machine cannot be read does not start again where it cannot", () => {
    expect(offers({ status: "error", running: false }, { kind: "unreadable" }).resume).toBe(false);
  });
});

describe("the next step a reason comes with (F-009)", () => {
  it("cannot read where it runs: set it up again", () => {
    expect(
      monitorNextSteps(monitor({ status: "error", running: false }), { kind: "unreadable" }, false)
    ).toEqual([{ id: "setUpAgain", label: "Set it up again" }]);
  });

  it("its agent is offline: connect it", () => {
    const m = monitor({ status: "notReachable" });
    const host = { kind: "agent", agentId: "a" } as const;
    expect(monitorNextSteps(m, host, false)).toEqual([
      { id: "connectAgent", label: "Connect agent" },
    ]);
    expect(monitorNextSteps(m, host, true)).toEqual([]);
  });

  it("a healthy one here has none", () => {
    expect(monitorNextSteps(monitor(), { kind: "thisComputer" }, false)).toEqual([]);
  });
});
