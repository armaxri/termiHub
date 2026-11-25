import { describe, expect, it } from "vitest";
import type { ServerStatus } from "@/types/embeddedServer";
import type { TunnelStatus } from "@/types/tunnel";
import {
  isServiceActive,
  serverServiceState,
  serviceReason,
  serviceRunAction,
  serviceStateDot,
  serviceStateLabel,
  tunnelServiceState,
  type ServiceState,
} from "./serviceState";

/** The table of docs/concepts/backlog/services.html, "States and actions". */
const TABLE: [ServiceState, string, string, "hollow" | "pulse" | "", string | null, boolean][] = [
  // state, word, tone, dot, run, may hold a port
  ["stopped", "Stopped", "neutral", "", "start", false],
  ["waiting", "Waiting", "neutral", "hollow", "stopWaiting", false],
  ["starting", "Starting", "warning", "pulse", "stop", true],
  ["running", "Running", "success", "", "stop", true],
  ["reconnecting", "Reconnecting", "warning", "pulse", "stop", true],
  ["stopping", "Stopping", "warning", "pulse", null, true],
  ["error", "Error", "error", "", "retry", false],
  ["needsConnection", "Needs a connection", "error", "", null, false],
  ["notReachable", "Not reachable", "warning", "hollow", "stop", true],
];

describe("the nine service states (#6028)", () => {
  it.each(TABLE)("%s reads %s", (state, word, tone, dot, run, active) => {
    expect(serviceStateLabel(state)).toBe(word);
    expect(serviceStateDot(state)).toEqual({
      tone,
      pulse: dot === "pulse",
      hollow: dot === "hollow",
      label: word,
      title: word,
    });
    expect(serviceRunAction(state)).toBe(run);
    expect(isServiceActive(state)).toBe(active);
  });

  it("only running is green", () => {
    const green = TABLE.filter(([state]) => serviceStateDot(state).tone === "success");
    expect(green.map(([state]) => state)).toEqual(["running"]);
  });

  it("red is for what needs the user, amber for what moves or is in doubt", () => {
    const of = (tone: string) =>
      TABLE.map(([state]) => state).filter((state) => serviceStateDot(state).tone === tone);
    expect(of("error")).toEqual(["error", "needsConnection"]);
    expect(of("warning")).toEqual(["starting", "reconnecting", "stopping", "notReachable"]);
  });

  it("no two states look alike but those that are in motion", () => {
    const still = TABLE.map(([state]) => serviceStateDot(state)).filter((dot) => !dot.pulse);
    const looks = still.map((dot) => `${dot.tone} ${dot.hollow}`);
    // Error and Needs a connection: both red, both need the user.
    expect(new Set(looks).size).toBe(looks.length - 1);
  });

  it("says why for every state the user may have to act on", () => {
    const says = TABLE.map(([state]) => state).filter((s) => serviceReason(s, "why") === "why");
    expect(says).toEqual(["waiting", "reconnecting", "stopping", "error", "notReachable"]);
    expect(serviceReason("running", "why")).toBeUndefined();
    expect(serviceReason("waiting", undefined)).toBeUndefined();
  });
});

describe("both kinds map onto the same states", () => {
  it.each<[TunnelStatus | undefined, ServiceState]>([
    [undefined, "stopped"],
    ["disconnected", "stopped"],
    ["waiting", "waiting"],
    ["connecting", "starting"],
    ["connected", "running"],
    ["reconnecting", "reconnecting"],
    ["stopping", "stopping"],
    ["error", "error"],
    ["missingConnection", "needsConnection"],
    ["notReachable", "notReachable"],
  ])("tunnel %s is %s", (status, state) => {
    expect(tunnelServiceState(status)).toBe(state);
  });

  it.each<[ServerStatus | undefined, ServiceState]>([
    [undefined, "stopped"],
    ["stopped", "stopped"],
    ["waiting", "waiting"],
    ["starting", "starting"],
    ["running", "running"],
    ["stopping", "stopping"],
    ["error", "error"],
    ["notReachable", "notReachable"],
  ])("file server %s is %s", (status, state) => {
    expect(serverServiceState(status)).toBe(state);
  });
});
