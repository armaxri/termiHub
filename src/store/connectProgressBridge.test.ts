import { describe, it, expect, beforeEach } from "vitest";
import {
  beginConnectAttempt,
  clearConnectProgress,
  recordConnectProgress,
  useConnectProgressStore,
} from "./connectProgressBridge";

describe("connectProgressBridge", () => {
  beforeEach(() => useConnectProgressStore.setState({ byTab: {}, currentAttempt: {} }));

  it("keys each report by the tab id parsed from the connect id", () => {
    recordConnectProgress({ connectId: "tab-1:0", stage: "resolve", status: "Resolving h" });
    recordConnectProgress({ connectId: "tab-1:0", stage: "connect", status: null });
    expect(useConnectProgressStore.getState().byTab["tab-1"]).toEqual({
      connectId: "tab-1:0",
      stage: "connect",
      status: null,
    });
  });

  it("ignores a connect id without a tab prefix and clears per tab", () => {
    recordConnectProgress({ connectId: "bogus", stage: "resolve", status: null });
    expect(useConnectProgressStore.getState().byTab).toEqual({});
    recordConnectProgress({ connectId: "t:1", stage: "session", status: null });
    clearConnectProgress("t");
    expect(useConnectProgressStore.getState().byTab).toEqual({});
  });

  it("ignores a stale report from an earlier attempt of the same tab (#5081)", () => {
    beginConnectAttempt("tab-1", "tab-1:1");
    recordConnectProgress({ connectId: "tab-1:0", stage: "connect", status: "old attempt" });
    expect(useConnectProgressStore.getState().byTab["tab-1"]).toBeUndefined();
    recordConnectProgress({ connectId: "tab-1:1", stage: "resolve", status: null });
    expect(useConnectProgressStore.getState().byTab["tab-1"]?.connectId).toBe("tab-1:1");
  });
});
