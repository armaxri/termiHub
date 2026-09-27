import { describe, expect, it } from "vitest";
import type { MonitorStatus } from "@/types/monitoring";
import {
  RECONNECTING_HEADING,
  isFrozenMonitorBadge,
  monitorStatusBadge,
  reconnectAttemptLabel,
} from "./reconnectStatus";
import { RECONNECT_POLICY } from "./reconnectBackoff";

describe("reconnectStatus — shared wording (#3730)", () => {
  it("uses one heading for every reconnecting surface", () => {
    expect(RECONNECTING_HEADING).toBe("Connection lost — reconnecting…");
  });

  it("labels attempt progress against the shared budget", () => {
    expect(reconnectAttemptLabel(3, RECONNECT_POLICY.maxAttempts)).toBe("Attempt 3 of 10");
    expect(reconnectAttemptLabel(10, 10)).toBe("Attempt 10 of 10");
  });

  it("reads an attempt below 1 as the first attempt", () => {
    expect(reconnectAttemptLabel(0, 10)).toBe("Attempt 1 of 10");
    expect(reconnectAttemptLabel(-2, 10)).toBe("Attempt 1 of 10");
  });

  it("omits the budget when it is unbounded", () => {
    expect(reconnectAttemptLabel(4, 0)).toBe("Attempt 4");
  });
});

describe("reconnectStatus — monitoring badge precedence", () => {
  const statuses: (MonitorStatus | null)[] = [
    null,
    "connecting",
    "live",
    "stale",
    "reconnecting",
    "offline",
    "paused",
  ];

  it("maps each status to its badge when not paused", () => {
    expect(statuses.map((s) => monitorStatusBadge(s, false))).toEqual([
      null,
      null,
      null,
      "stale",
      "reconnecting",
      "offline",
      "paused",
    ]);
  });

  it("lets a link problem outrank a user pause", () => {
    expect(monitorStatusBadge("offline", true)).toBe("offline");
    expect(monitorStatusBadge("reconnecting", true)).toBe("reconnecting");
    expect(monitorStatusBadge("stale", true)).toBe("stale");
    expect(monitorStatusBadge("live", true)).toBe("paused");
  });

  it("shows exactly one badge for every status and pause combination", () => {
    for (const s of statuses) {
      for (const p of [false, true]) {
        const badge = monitorStatusBadge(s, p);
        expect([null, "offline", "reconnecting", "stale", "paused"]).toContain(badge);
      }
    }
  });

  it("dims the numbers for every frozen badge, never for live or offline", () => {
    expect(isFrozenMonitorBadge("stale")).toBe(true);
    expect(isFrozenMonitorBadge("reconnecting")).toBe(true);
    expect(isFrozenMonitorBadge("paused")).toBe(true);
    expect(isFrozenMonitorBadge("offline")).toBe(false);
    expect(isFrozenMonitorBadge(null)).toBe(false);
  });
});
