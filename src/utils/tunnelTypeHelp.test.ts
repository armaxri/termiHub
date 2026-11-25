import { describe, it, expect } from "vitest";
import { THIS_COMPUTER, type RunLocation, type TunnelType } from "@/types/tunnel";
import { tunnelEndpointLines } from "./tunnelHost";
import { TUNNEL_TYPE_KINDS, tunnelTypeHelp, tunnelTypeLabel } from "./tunnelTypeHelp";

const AGENT: RunLocation = { kind: "agent", agentId: "agent-1" };

/** A forward of each type, to compare the help with the editor's endpoint lines. */
const FORWARDS: Record<TunnelType["type"], TunnelType> = {
  local: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
  },
  remote: {
    type: "remote",
    config: { remoteHost: "127.0.0.1", remotePort: 8080, localHost: "127.0.0.1", localPort: 3000 },
  },
  dynamic: { type: "dynamic", config: { localHost: "127.0.0.1", localPort: 1080 } },
};

describe("tunnelTypeHelp (#6027)", () => {
  it("names each type with its ssh flag", () => {
    expect(
      TUNNEL_TYPE_KINDS.map((kind) => [tunnelTypeLabel(kind), tunnelTypeHelp(kind).flag])
    ).toEqual([
      ["Local", "ssh -L"],
      ["Remote", "ssh -R"],
      ["Dynamic", "ssh -D"],
    ]);
  });

  it("explains a tunnel on this computer", () => {
    expect(tunnelTypeHelp("local")).toMatchObject({
      summary: "Reach something on the SSH server's side",
      lines: [
        "Use something on the SSH server's side as if it ran here.",
        "Opens a port on this computer and sends its traffic through SSH to a host and port the SSH server can reach.",
        "Example: a database only the SSH server can reach, at localhost:5432 on this computer.",
      ],
    });
    expect(tunnelTypeHelp("remote", THIS_COMPUTER).lines[1]).toBe(
      "Opens a port on the SSH server and sends its traffic back through SSH to a host and port this computer can reach."
    );
    expect(tunnelTypeHelp("dynamic").lines[1]).toBe(
      "Opens a SOCKS5 proxy on this computer. Programs set to use it connect from the SSH server."
    );
  });

  it("names the agent, never this computer or here, for an agent-hosted tunnel", () => {
    for (const kind of TUNNEL_TYPE_KINDS) {
      const { summary, lines } = tunnelTypeHelp(kind, AGENT, "build-box");
      const text = [summary, ...lines].join(" ");
      expect(text).toContain("agent build-box");
      expect(text).not.toMatch(/this computer|\bhere\b/);
      expect(text).not.toMatch(/[{}]/);
    }
    expect(tunnelTypeHelp("remote", AGENT, "build-box").summary).toBe(
      "Let the SSH server reach something on agent build-box's side"
    );
  });

  it("falls back to the agent's id", () => {
    expect(tunnelTypeHelp("local", AGENT).lines[1]).toContain("on agent agent-1 ");
  });

  // The bind side and the destination side must match what the endpoint lines
  // of the same tunnel say, so the two texts in the editor cannot disagree.
  it.each([
    [THIS_COMPUTER, undefined, "this computer"],
    [AGENT, "build-box", "agent build-box"],
  ] as const)("binds where the endpoint lines say (%o)", (host, agentName, machine) => {
    const [localListen] = tunnelEndpointLines(FORWARDS.local, host, { agentName });
    expect(localListen.machine).toBe(machine);
    expect(tunnelTypeHelp("local", host, agentName).lines[1]).toContain(`port on ${machine} `);

    const [remoteListen, remoteTarget] = tunnelEndpointLines(FORWARDS.remote, host, { agentName });
    expect(remoteListen.machine).toContain("SSH server");
    expect(remoteTarget.machine).toBe(machine);
    const remoteHow = tunnelTypeHelp("remote", host, agentName).lines[1];
    expect(remoteHow).toContain("port on the SSH server ");
    expect(remoteHow).toContain(`${machine} can reach`);

    const [socks] = tunnelEndpointLines(FORWARDS.dynamic, host, { agentName });
    expect(socks.machine).toBe(machine);
    expect(tunnelTypeHelp("dynamic", host, agentName).lines[1]).toContain(`proxy on ${machine}.`);
  });
});
