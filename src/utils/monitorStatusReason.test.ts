import { describe, it, expect } from "vitest";
import { monitorOfflineLabel, monitorOfflineReasonText } from "./monitorStatusReason";

describe("monitorOfflineReasonText (#3301)", () => {
  it("says the remote output is unreadable for a parse failure", () => {
    expect(monitorOfflineReasonText("parse")).toBe("remote output unreadable");
  });

  it("says the connection was lost for a transport failure", () => {
    expect(monitorOfflineReasonText("transport")).toBe("connection lost");
  });

  it("says no data arrived from the agent for a silent agent", () => {
    expect(monitorOfflineReasonText("silent")).toBe("no data from agent");
  });

  it("says monitoring is not supported for a host with no stats source (#5471)", () => {
    expect(monitorOfflineReasonText("unsupported")).toBe("monitoring not supported on this host");
  });

  it("falls back to connection lost when no reason is known", () => {
    expect(monitorOfflineReasonText(null)).toBe("connection lost");
    expect(monitorOfflineReasonText(undefined)).toBe("connection lost");
  });
});

describe("monitorOfflineLabel (#3301)", () => {
  it("prefixes the reason with Offline", () => {
    expect(monitorOfflineLabel("parse")).toBe("Offline — remote output unreadable");
    expect(monitorOfflineLabel(null)).toBe("Offline — connection lost");
  });

  it("does not call an unsupported host offline (#5471)", () => {
    expect(monitorOfflineLabel("unsupported")).toBe("Monitoring not supported on this host");
  });
});
