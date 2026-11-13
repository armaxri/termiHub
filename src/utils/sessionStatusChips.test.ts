import { describe, it, expect } from "vitest";
import type { ConnectionConfig } from "@/types/terminal";
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
