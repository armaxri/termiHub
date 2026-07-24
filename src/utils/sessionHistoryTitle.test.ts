import { describe, it, expect } from "vitest";
import { sessionHistoryTitle, sessionTypeBadge } from "./sessionHistoryTitle";
import type { ConnectionConfig } from "@/types/terminal";

const cfg = (type: string, config: Record<string, unknown>): ConnectionConfig => ({
  type,
  config,
});

describe("sessionHistoryTitle", () => {
  it("uses user@host for SSH", () => {
    expect(sessionHistoryTitle("ssh", cfg("ssh", { host: "prod", username: "admin" }))).toBe(
      "admin@prod"
    );
  });

  it("falls back to host when SSH has no user", () => {
    expect(sessionHistoryTitle("ssh", cfg("ssh", { host: "prod" }))).toBe("prod");
  });

  it("shows host:port for non-default telnet ports", () => {
    expect(sessionHistoryTitle("telnet", cfg("telnet", { host: "sw", port: 2323 }))).toBe(
      "sw:2323"
    );
    expect(sessionHistoryTitle("telnet", cfg("telnet", { host: "sw", port: 23 }))).toBe("sw");
  });

  it("uses the device path for serial", () => {
    expect(sessionHistoryTitle("serial", cfg("serial", { device: "/dev/ttyUSB0" }))).toBe(
      "/dev/ttyUSB0"
    );
  });

  it("uses the container name for docker", () => {
    expect(sessionHistoryTitle("docker", cfg("docker", { container: "nginx" }))).toBe("nginx");
  });

  it("uses the shell basename for local", () => {
    expect(sessionHistoryTitle("local", cfg("local", { shell: "/bin/zsh" }))).toBe("zsh");
    expect(sessionHistoryTitle("local", cfg("local", {}))).toBe("Local Shell");
  });

  it("shows the distro for a wsl local shell", () => {
    expect(sessionHistoryTitle("local", cfg("local", { shell: "wsl:Ubuntu" }))).toBe("Ubuntu");
  });
});

describe("sessionTypeBadge", () => {
  it("maps known types to short labels", () => {
    expect(sessionTypeBadge("ssh")).toBe("SSH");
    expect(sessionTypeBadge("serial")).toBe("Serial");
    expect(sessionTypeBadge("docker")).toBe("Docker");
    expect(sessionTypeBadge("local")).toBe("Local");
    expect(sessionTypeBadge("remote-session")).toBe("Agent");
  });

  it("passes through an unknown type", () => {
    expect(sessionTypeBadge("mystery")).toBe("mystery");
  });
});
