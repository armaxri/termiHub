import { describe, it, expect } from "vitest";
import {
  getJumpHosts,
  hasJumpHost,
  jumpHostTooltip,
  jumpHostStatusLabel,
  jumpHostGatewayConnection,
} from "./jumpHost";
import { JumpHostConfig, SavedConnection } from "@/types/connection";
import { ConnectionConfig } from "@/types/terminal";

function hop(host: string, username = "admin"): JumpHostConfig {
  return { host, port: 22, username, authMethod: "key" };
}

function sshConfig(settings: Record<string, unknown>): ConnectionConfig {
  return { type: "ssh", config: settings };
}

describe("getJumpHosts", () => {
  it("returns the proxyJump chain for an SSH connection", () => {
    const config = sshConfig({ host: "target", username: "deploy", proxyJump: [hop("bastion")] });
    expect(getJumpHosts(config)).toHaveLength(1);
    expect(getJumpHosts(config)[0].host).toBe("bastion");
  });

  it("returns an empty array for non-SSH connections", () => {
    const config: ConnectionConfig = { type: "telnet", config: { proxyJump: [hop("bastion")] } };
    expect(getJumpHosts(config)).toEqual([]);
  });

  it("returns an empty array when no proxyJump is set", () => {
    expect(getJumpHosts(sshConfig({ host: "target" }))).toEqual([]);
  });

  it("tolerates the legacy jumpHosts alias", () => {
    const config = sshConfig({ host: "target", jumpHosts: [hop("bastion")] });
    expect(getJumpHosts(config)).toHaveLength(1);
  });

  it("is safe for undefined/null configs", () => {
    expect(getJumpHosts(undefined)).toEqual([]);
    expect(getJumpHosts(null)).toEqual([]);
  });
});

describe("hasJumpHost", () => {
  it("is true only when a chain is present", () => {
    expect(hasJumpHost(sshConfig({ proxyJump: [hop("bastion")] }))).toBe(true);
    expect(hasJumpHost(sshConfig({}))).toBe(false);
  });
});

describe("jumpHostTooltip", () => {
  it("joins hops with arrows", () => {
    expect(jumpHostTooltip([hop("edge"), hop("bastion")])).toBe("Via: edge → bastion");
  });

  it("appends the target name when provided", () => {
    expect(jumpHostTooltip([hop("edge"), hop("bastion")], "db-server")).toBe(
      "Via: edge → bastion → db-server"
    );
  });

  it("is empty for no hops", () => {
    expect(jumpHostTooltip([])).toBe("");
  });
});

describe("jumpHostStatusLabel", () => {
  it("renders user@target via gateway", () => {
    const config = sshConfig({
      host: "app-server",
      username: "deploy",
      proxyJump: [hop("bastion")],
    });
    expect(jumpHostStatusLabel(config)).toBe("deploy@app-server via bastion");
  });

  it("joins multi-hop gateways", () => {
    const config = sshConfig({
      host: "db-server",
      username: "deploy",
      proxyJump: [hop("edge"), hop("bastion")],
    });
    expect(jumpHostStatusLabel(config)).toBe("deploy@db-server via edge → bastion");
  });

  it("falls back to host-only when username is absent", () => {
    const config = sshConfig({ host: "app-server", proxyJump: [hop("bastion")] });
    expect(jumpHostStatusLabel(config)).toBe("app-server via bastion");
  });

  it("is empty without a jump host", () => {
    expect(jumpHostStatusLabel(sshConfig({ host: "app-server" }))).toBe("");
  });
});

describe("jumpHostGatewayConnection", () => {
  function savedConn(settings: Record<string, unknown>): SavedConnection {
    return {
      id: "Work/app-server",
      name: "app-server",
      folderId: null,
      config: sshConfig(settings),
    };
  }

  it("targets the (single) bastion directly with no further hops", () => {
    const gw = jumpHostGatewayConnection(
      savedConn({ host: "app-server", username: "deploy", proxyJump: [hop("bastion")] })
    );
    expect(gw).not.toBeNull();
    expect(gw!.config.config.host).toBe("bastion");
    expect(gw!.config.config.proxyJump).toBeUndefined();
    expect(gw!.id).toBe("Work/app-server::jump-host");
    expect(gw!.name).toContain("bastion");
  });

  it("targets the innermost gateway through the remaining outer hops", () => {
    const gw = jumpHostGatewayConnection(
      savedConn({ host: "db", username: "deploy", proxyJump: [hop("edge"), hop("bastion")] })
    );
    expect(gw!.config.config.host).toBe("bastion");
    expect(gw!.config.config.proxyJump).toHaveLength(1);
    expect((gw!.config.config.proxyJump as JumpHostConfig[])[0].host).toBe("edge");
  });

  it("returns null when there is no jump host", () => {
    expect(jumpHostGatewayConnection(savedConn({ host: "app-server" }))).toBeNull();
  });
});
