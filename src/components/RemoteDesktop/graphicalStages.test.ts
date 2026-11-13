/**
 * The graphical connect stepper (#5626): Connect → Authenticate → First frame,
 * with an SSH tunnel step first for a tunnelled session, and the
 * "via SSH user@host" label read from the connection config.
 */
import { describe, it, expect } from "vitest";
import { graphicalStages, sshTunnelVia } from "./graphicalStages";

const states = (at: Parameters<typeof graphicalStages>[0], tunnelled: boolean) =>
  graphicalStages(at, tunnelled).map((s) => `${s.label}:${s.state}`);

describe("graphicalStages", () => {
  it("walks Connect → Authenticate → First frame for a direct session", () => {
    expect(states("connect", false)).toEqual([
      "Connect:active",
      "Authenticate:pending",
      "First frame:pending",
    ]);
    expect(states("authenticate", false)).toEqual([
      "Connect:done",
      "Authenticate:active",
      "First frame:pending",
    ]);
    expect(states("firstFrame", false)).toEqual([
      "Connect:done",
      "Authenticate:done",
      "First frame:active",
    ]);
  });

  it("puts the SSH tunnel first for a tunnelled session", () => {
    expect(states("connect", true)).toEqual([
      "SSH tunnel:active",
      "Connect:pending",
      "Authenticate:pending",
      "First frame:pending",
    ]);
    expect(states("firstFrame", true)).toEqual([
      "SSH tunnel:done",
      "Connect:done",
      "Authenticate:done",
      "First frame:active",
    ]);
  });

  it("marks the current step failed on request", () => {
    const stages = graphicalStages("firstFrame", false, true);
    expect(stages.map((s) => s.state)).toEqual(["done", "done", "failed"]);
  });
});

describe("sshTunnelVia", () => {
  it("is null for a direct connection", () => {
    expect(sshTunnelVia({ type: "vnc", config: { host: "h" } })).toBeNull();
    expect(sshTunnelVia({ type: "vnc", config: { useSshTunnel: false, sshHost: "b" } })).toBeNull();
    expect(sshTunnelVia(undefined)).toBeNull();
  });

  it("names user@host of the SSH gateway", () => {
    expect(
      sshTunnelVia({
        type: "vnc",
        config: { useSshTunnel: true, sshHost: "bastion", sshUsername: "arne" },
      })
    ).toBe("arne@bastion");
  });

  it("names the bare gateway host without a username", () => {
    expect(sshTunnelVia({ type: "rdp", config: { useSshTunnel: true, sshHost: "bastion" } })).toBe(
      "bastion"
    );
  });

  it("is null when the tunnel is on but has no host yet", () => {
    expect(sshTunnelVia({ type: "vnc", config: { useSshTunnel: true, sshHost: "" } })).toBeNull();
  });
});
