import { describe, it, expect, beforeEach } from "vitest";
import { THIS_COMPUTER } from "@/types/tunnel";
import { useRunLocationStore } from "./runLocationStore";

describe("runLocationStore", () => {
  beforeEach(() => {
    useRunLocationStore.setState({ networkToolLocations: {}, serverLocations: {} });
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

  it("records a server's run-location independently of tools", () => {
    const { setServerLocation, setNetworkToolLocation } = useRunLocationStore.getState();
    setServerLocation("srv-1", { kind: "agent", agentId: "a2" });
    setNetworkToolLocation("dns", { kind: "agent", agentId: "a1" });

    expect(useRunLocationStore.getState().serverLocations["srv-1"]).toEqual({
      kind: "agent",
      agentId: "a2",
    });
    expect(useRunLocationStore.getState().networkToolLocations.dns).toEqual({
      kind: "agent",
      agentId: "a1",
    });
  });
});
