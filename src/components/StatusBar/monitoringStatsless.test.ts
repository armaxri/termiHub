import { describe, it, expect } from "vitest";
import { statslessMonitorChip } from "./monitoringStatsless";

describe("statslessMonitorChip (#5840)", () => {
  it("waits for the first reading while connecting or live", () => {
    expect(statslessMonitorChip("connecting", null, false)).toBe("waiting");
    expect(statslessMonitorChip("live", null, false)).toBe("waiting");
    expect(statslessMonitorChip(null, null, false)).toBe("waiting");
  });

  it("says unavailable when collects fail before the first sample", () => {
    expect(statslessMonitorChip("stale", "transport", false)).toBe("unavailable");
    expect(statslessMonitorChip("reconnecting", "parse", false)).toBe("unavailable");
  });

  it("says unsupported for a host with no stats source, before it resolves offline", () => {
    expect(statslessMonitorChip("stale", "unsupported", false)).toBe("unsupported");
  });

  it("leaves offline and paused to their own chips", () => {
    expect(statslessMonitorChip("offline", "transport", false)).toBeNull();
    expect(statslessMonitorChip("offline", "unsupported", false)).toBeNull();
    expect(statslessMonitorChip("live", null, true)).toBeNull();
    expect(statslessMonitorChip("paused", null, false)).toBeNull();
  });
});
