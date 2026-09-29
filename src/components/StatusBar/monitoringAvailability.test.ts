import { describe, it, expect } from "vitest";
import { fakeStats } from "@/test/systemMonitorHarness";
import { isMetricUnavailable, statsSourceLabel, unavailableTitle } from "./monitoringAvailability";

describe("monitoringAvailability (#3202)", () => {
  it("treats a sample without an unavailable list as fully available", () => {
    const stats = fakeStats("host");
    expect(isMetricUnavailable(stats, "disk")).toBe(false);
    expect(statsSourceLabel(stats)).toBeNull();
  });

  it("reports listed metrics as unavailable", () => {
    const stats = { ...fakeStats("c"), unavailableMetrics: ["disk" as const, "uptime" as const] };
    expect(isMetricUnavailable(stats, "disk")).toBe(true);
    expect(isMetricUnavailable(stats, "uptime")).toBe(true);
    expect(isMetricUnavailable(stats, "cpu")).toBe(false);
  });

  it("labels Docker stats samples and leaves /proc samples unlabelled", () => {
    expect(statsSourceLabel({ ...fakeStats("c"), source: "dockerStats" })).toBe("via Docker stats");
    expect(statsSourceLabel({ ...fakeStats("c"), source: "proc" })).toBeNull();
  });

  it("names the source in the unavailable tooltip when there is one", () => {
    expect(unavailableTitle("Disk", { ...fakeStats("c"), source: "dockerStats" })).toBe(
      "Disk: unavailable via Docker stats"
    );
    expect(unavailableTitle("Disk", fakeStats("c"))).toBe("Disk: unavailable");
  });
});
