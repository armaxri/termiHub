import { describe, it, expect } from "vitest";
import {
  buildStages,
  connectTargetOf,
  connectOverlayIdentity,
  connectTypeLabel,
  stepsFor,
  tabIdFromConnectId,
} from "./connectStages";

describe("connectStages", () => {
  it("gives each connection type its steps", () => {
    expect(stepsFor("ssh")).toEqual(["resolve", "connect", "hostKey", "authenticate", "shell"]);
    expect(stepsFor("telnet")).toEqual(["resolve", "connect", "session"]);
    expect(stepsFor("serial")).toEqual(["openPort", "session"]);
    expect(stepsFor("local")).toEqual(["start"]);
    expect(stepsFor("ssh", true)).toEqual(["agent", "start"]);
  });

  it("marks steps before the current one done and later ones pending", () => {
    const stages = buildStages(stepsFor("ssh"), "authenticate");
    expect(stages.map((s) => s.state)).toEqual(["done", "done", "done", "active", "pending"]);
    expect(stages[2].label).toBe("Host key");
  });

  it("marks the current step failed on failure, and starts at the first step", () => {
    expect(buildStages(stepsFor("telnet"), "connect", true).map((s) => s.state)).toEqual([
      "done",
      "failed",
      "pending",
    ]);
    expect(buildStages(stepsFor("telnet"), undefined).map((s) => s.state)).toEqual([
      "active",
      "pending",
      "pending",
    ]);
  });

  it("parses the tab id from a connect id", () => {
    expect(tabIdFromConnectId("tab-1:0")).toBe("tab-1");
    expect(tabIdFromConnectId("a:b:3")).toBe("a:b");
    expect(tabIdFromConnectId("nocolon")).toBeNull();
  });

  it("labels types and reads targets from the config", () => {
    expect(connectTypeLabel("telnet")).toBe("Telnet");
    expect(connectTypeLabel("kube-exec")).toBe("Kube-exec");
    expect(connectTargetOf("telnet", { host: "192.168.0.42", port: 23 })).toEqual({
      target: "192.168.0.42",
      details: ["port 23"],
    });
    expect(
      connectTargetOf("ssh", { host: "db", port: "22", proxyJump: [{ host: "bastion" }] })
    ).toEqual({ target: "db", details: ["port 22", "via bastion"] });
    expect(connectTargetOf("serial", { port: "/dev/ttyUSB0", baudRate: 115200 })).toEqual({
      target: "/dev/ttyUSB0",
      details: ["115200 baud"],
    });
    expect(connectTargetOf("local", {})).toEqual({ details: [] });
  });
});

describe("connectOverlayIdentity", () => {
  it("unwraps an agent session's inner type", () => {
    expect(
      connectOverlayIdentity({
        type: "remote-session",
        config: { agentId: "a", sessionType: "ssh", host: "db" },
      })
    ).toEqual({ sessionType: "ssh", viaAgent: true, target: "db", details: [] });
    expect(connectOverlayIdentity({ type: "local", config: {} })).toEqual({
      sessionType: "local",
      viaAgent: false,
      details: [],
    });
  });
});
