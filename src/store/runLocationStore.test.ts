import { describe, it, expect, beforeEach } from "vitest";
import { THIS_COMPUTER } from "@/types/tunnel";
import { useRunLocationStore } from "./runLocationStore";

describe("runLocationStore", () => {
  beforeEach(() => {
    useRunLocationStore.setState({
      networkToolLocations: {},
      systemMonitorLocations: {},
    });
  });

  it("records and updates a network tool's run-location", () => {
    const { setNetworkToolLocation } = useRunLocationStore.getState();
    expect(useRunLocationStore.getState().networkToolLocations.ping).toBeUndefined();

    setNetworkToolLocation("ping", { kind: "agent", agentId: "a1" });
    expect(useRunLocationStore.getState().networkToolLocations.ping).toEqual({
      kind: "agent",
      agentId: "a1",
    });

    setNetworkToolLocation("ping", THIS_COMPUTER);
    expect(useRunLocationStore.getState().networkToolLocations.ping).toEqual(THIS_COMPUTER);
  });

  it("records a system monitor's run-location keyed by monitor key (#2593)", () => {
    const { setSystemMonitorLocation } = useRunLocationStore.getState();
    expect(useRunLocationStore.getState().systemMonitorLocations["sess-1"]).toBeUndefined();

    setSystemMonitorLocation("sess-1", { kind: "agent", agentId: "build" });
    expect(useRunLocationStore.getState().systemMonitorLocations["sess-1"]).toEqual({
      kind: "agent",
      agentId: "build",
    });

    // A second monitor's vantage is independent of the first.
    setSystemMonitorLocation("sess-2", THIS_COMPUTER);
    expect(useRunLocationStore.getState().systemMonitorLocations["sess-2"]).toEqual(THIS_COMPUTER);
    expect(useRunLocationStore.getState().systemMonitorLocations["sess-1"]).toEqual({
      kind: "agent",
      agentId: "build",
    });
  });
});
