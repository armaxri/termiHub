import { describe, it, expect } from "vitest";
import type { RunLocation, TunnelType } from "@/types/tunnel";
import {
  resolveTunnelHost,
  isAgentHost,
  isLoopbackBind,
  tunnelHostBadge,
  tunnelEndpointLines,
  tunnelReachabilityWarning,
  reportedReachability,
} from "./tunnelHost";

const AGENT: RunLocation = { kind: "agent", agentId: "agent-1" };
const THIS: RunLocation = { kind: "thisComputer" };

const local = (localHost = "127.0.0.1"): TunnelType => ({
  type: "local",
  config: { localHost, localPort: 5432, remoteHost: "db.internal", remotePort: 5432 },
});
const remote = (): TunnelType => ({
  type: "remote",
  config: { remoteHost: "0.0.0.0", remotePort: 8080, localHost: "127.0.0.1", localPort: 3000 },
});
const dynamic = (localHost = "127.0.0.1"): TunnelType => ({
  type: "dynamic",
  config: { localHost, localPort: 1080 },
});

describe("resolveTunnelHost", () => {
  it("defaults a missing host to This computer", () => {
    expect(resolveTunnelHost({ host: undefined })).toEqual({ kind: "thisComputer" });
  });
  it("returns an explicit host unchanged", () => {
    expect(resolveTunnelHost({ host: AGENT })).toEqual(AGENT);
  });
});

describe("isAgentHost / isLoopbackBind", () => {
  it("narrows the agent variant", () => {
    expect(isAgentHost(AGENT)).toBe(true);
    expect(isAgentHost(THIS)).toBe(false);
  });
  it("recognises loopback binds but not widened ones", () => {
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
    expect(isLoopbackBind("localhost")).toBe(true);
    expect(isLoopbackBind("::1")).toBe(true);
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
    expect(isLoopbackBind("10.0.0.5")).toBe(false);
  });
});

describe("tunnelHostBadge", () => {
  it("reads 'this computer' for the desktop host", () => {
    expect(tunnelHostBadge(THIS)).toEqual({ label: "this computer", onAgent: false });
  });
  it("names the agent, preferring the resolved name over the id", () => {
    expect(tunnelHostBadge(AGENT, "build-box")).toEqual({ label: "build-box", onAgent: true });
    expect(tunnelHostBadge(AGENT)).toEqual({ label: "agent-1", onAgent: true });
  });
});

describe("tunnelEndpointLines", () => {
  it("names the concrete machine on an agent-hosted local forward", () => {
    const lines = tunnelEndpointLines(local(), AGENT, {
      agentName: "build-box",
      sshLabel: "bastion",
    });
    expect(lines[0].label).toBe("Listens on");
    expect(lines[0].machine).toBe("agent build-box");
    expect(lines[0].address).toBe("127.0.0.1:5432");
    expect(lines[0].note).toContain("only from processes on build-box");
    expect(lines[1].machine).toContain("SSH server bastion");
    expect(lines[2].label).toBe("Forwards to");
    expect(lines[2].note).toContain("resolved from the SSH server");
  });

  it("keeps the desktop-hosted local forward reading 'this computer'", () => {
    const lines = tunnelEndpointLines(local(), THIS, { sshLabel: "bastion" });
    expect(lines[0].machine).toBe("this computer");
    expect(lines[0].note).toContain("apps on this computer");
  });

  it("puts the listen side on the SSH server for a remote forward", () => {
    const lines = tunnelEndpointLines(remote(), AGENT, { agentName: "build-box" });
    expect(lines[0].machine).toContain("SSH server");
    expect(lines[1].label).toBe("Forwards to");
    expect(lines[1].machine).toBe("agent build-box");
  });

  it("labels the dynamic proxy on the tunnel host", () => {
    const lines = tunnelEndpointLines(dynamic(), THIS);
    expect(lines[0].label).toBe("SOCKS5 proxy on");
    expect(lines[0].machine).toBe("this computer");
  });
});

describe("tunnelReachabilityWarning", () => {
  it("fires for an agent-hosted loopback local forward", () => {
    const w = tunnelReachabilityWarning(local("127.0.0.1"), AGENT, "build-box");
    expect(w).not.toBeNull();
    expect(w?.message).toContain("build-box");
    expect(w?.bindHost).toBe("127.0.0.1");
  });

  it("fires for an agent-hosted loopback dynamic proxy", () => {
    expect(tunnelReachabilityWarning(dynamic("localhost"), AGENT)).not.toBeNull();
  });

  it("does not fire when the agent bind is widened", () => {
    expect(tunnelReachabilityWarning(local("0.0.0.0"), AGENT)).toBeNull();
  });

  it("does not fire for desktop-hosted tunnels", () => {
    expect(tunnelReachabilityWarning(local("127.0.0.1"), THIS)).toBeNull();
  });

  it("does not fire for a remote forward (listen is on the SSH server)", () => {
    expect(tunnelReachabilityWarning(remote(), AGENT)).toBeNull();
  });
});

describe("reportedReachability", () => {
  it("warns for a loopback bind on the agent (agentOnly)", () => {
    const r = reportedReachability("agentOnly", "build-box");
    expect(r).toEqual({ label: "reachable only on build-box", warn: true });
  });

  it("does not warn for a widened bind on the agent LAN", () => {
    const r = reportedReachability("agentLan", "build-box");
    expect(r).toEqual({ label: "reachable on build-box's network", warn: false });
  });

  it("describes an -R forward as reachable on the SSH server's network", () => {
    const r = reportedReachability("sshServer", "build-box");
    expect(r).toEqual({ label: "reachable on the SSH server's network", warn: false });
  });

  it("returns null when the agent has not reported (undefined)", () => {
    expect(reportedReachability(undefined, "build-box")).toBeNull();
  });
});
