import { describe, it, expect } from "vitest";
import type { ConnectionConfig } from "@/types/terminal";
import type { SshHostKeyTrust } from "@/types/generated/SshHostKeyTrust";
import type { SshHostKeyTrustedEvent } from "@/types/generated/SshHostKeyTrustedEvent";
import { serialStatusChip, sshStatusChip } from "./sessionStatusChips";

function ssh(config: Record<string, unknown>): ConnectionConfig {
  return { type: "ssh", config } as ConnectionConfig;
}

function serial(config: Record<string, unknown>): ConnectionConfig {
  return { type: "serial", config } as ConnectionConfig;
}

describe("sshStatusChip (#5628)", () => {
  it("shows user@host:port for a direct key-auth connection", () => {
    const chip = sshStatusChip(
      ssh({
        host: "127.0.0.1",
        port: 22400,
        username: "arne",
        authMethod: "key",
        keyPath: "~/.ssh/pr",
      })
    );
    expect(chip?.label).toBe("arne@127.0.0.1:22400");
    expect(chip?.tooltip).toContain("SSH: arne@127.0.0.1:22400");
    expect(chip?.tooltip).toContain("Auth: key ~/.ssh/pr");
  });

  it("defaults the port to 22", () => {
    expect(sshStatusChip(ssh({ host: "box", username: "u" }))?.label).toBe("u@box:22");
  });

  it("names agent and password auth", () => {
    expect(sshStatusChip(ssh({ host: "h", authMethod: "agent" }))?.tooltip).toContain(
      "Auth: SSH agent"
    );
    expect(sshStatusChip(ssh({ host: "h", authMethod: "password" }))?.tooltip).toContain(
      "Auth: password"
    );
  });

  it("shows host:port for both ends of a jump", () => {
    const chip = sshStatusChip(
      ssh({
        host: "127.0.0.1",
        port: 22400,
        username: "arne",
        proxyJump: [{ host: "127.0.0.1", port: 22401, username: "arne", authMethod: "key" }],
      })
    );
    expect(chip?.label).toBe("arne@127.0.0.1:22400 via 127.0.0.1:22401");
  });

  it("joins a multi-hop chain", () => {
    const chip = sshStatusChip(
      ssh({
        host: "db",
        username: "u",
        proxyJump: [
          { host: "edge", port: 2201, username: "a", authMethod: "key" },
          { host: "bastion", port: 22, username: "a", authMethod: "key" },
        ],
      })
    );
    expect(chip?.label).toBe("u@db:22 via edge:2201 → bastion:22");
  });

  it("returns null for non-SSH configs and SSH without a host", () => {
    expect(sshStatusChip(serial({ port: "/dev/ttyS0" }))).toBeNull();
    expect(sshStatusChip(ssh({ host: "" }))).toBeNull();
    expect(sshStatusChip(undefined)).toBeNull();
  });
});

describe("serialStatusChip (#5628)", () => {
  it("shows port, baud and line settings", () => {
    const chip = serialStatusChip(
      serial({ port: "/dev/ttyPR0", baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1 })
    );
    expect(chip?.label).toBe("/dev/ttyPR0 · 9600 8N1");
    expect(chip?.tooltip).toContain("Serial: /dev/ttyPR0");
  });

  it("falls back to the backend defaults (115200 8N1) and accepts numeric strings", () => {
    expect(serialStatusChip(serial({ port: "COM3" }))?.label).toBe("COM3 · 115200 8N1");
    expect(
      serialStatusChip(
        serial({ port: "COM3", baudRate: "57600", dataBits: "7", parity: "even", stopBits: "2" })
      )?.label
    ).toBe("COM3 · 57600 7E2");
  });

  it("returns null without a port or for other types", () => {
    expect(serialStatusChip(serial({}))).toBeNull();
    expect(serialStatusChip(ssh({ host: "h" }))).toBeNull();
  });
});

describe("sshStatusChip host-key trust (#5669)", () => {
  function key(host: string, port: number, trust: SshHostKeyTrust): SshHostKeyTrustedEvent {
    return {
      owner: "tab-1:0",
      host,
      port,
      key_type: "ssh-ed25519",
      fingerprint: `SHA256:${host}${port}`,
      trust,
    };
  }

  it("names how the target's host key is trusted, with its fingerprint", () => {
    const cases: [SshHostKeyTrust, string][] = [
      ["remembered", "Host key: trusted (SHA256:h22)"],
      ["knownHosts", "Host key: trusted via ~/.ssh/known_hosts (SHA256:h22)"],
      ["firstSeenRemembered", "Host key: first seen, accepted and remembered (SHA256:h22)"],
      ["firstSeenOnce", "Host key: first seen, trusted once (this session only) (SHA256:h22)"],
      ["changedReplaced", "Host key: changed, new key accepted and remembered (SHA256:h22)"],
      ["changedOnce", "Host key: changed, trusted once (this session only) (SHA256:h22)"],
    ];
    for (const [trust, line] of cases) {
      const chip = sshStatusChip(ssh({ host: "h" }), [key("h", 22, trust)]);
      expect(chip?.tooltip.split("\n")).toContain(line);
    }
  });

  it("shows the target's key, not a jump hop's, and nothing before a key is known", () => {
    const config = ssh({
      host: "t",
      port: 2200,
      proxyJump: [{ host: "b", port: 22, username: "u", authMethod: "key" }],
    });
    expect(sshStatusChip(config)?.tooltip).not.toContain("Host key");
    expect(sshStatusChip(config, [key("b", 22, "remembered")])?.tooltip).not.toContain("Host key");
    const chip = sshStatusChip(config, [
      key("b", 22, "remembered"),
      key("t", 2200, "firstSeenOnce"),
    ]);
    expect(chip?.tooltip).toContain(
      "Host key: first seen, trusted once (this session only) (SHA256:t2200)"
    );
    expect(chip?.tooltip).not.toContain("SHA256:b22");
  });
});
