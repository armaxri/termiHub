import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types/terminal";
import {
  isDockerConnectionConfig,
  isLocalConnectionConfig,
  isSerialConnectionConfig,
  isSshConnectionConfig,
  isTelnetConnectionConfig,
  isWslConnectionConfig,
} from "./typedConnectionConfig";

const cfg = (type: string, config: Record<string, unknown> = {}): ConnectionConfig => ({
  type,
  config,
});

describe("typedConnectionConfig guards", () => {
  it("narrows a local config and exposes typed shell fields", () => {
    const c = cfg("local", { shell: "zsh", initialCommand: "ls" });
    expect(isLocalConnectionConfig(c)).toBe(true);
    if (isLocalConnectionConfig(c)) {
      // Typed reads (compile-time): real types, no cast needed.
      const shell: string | undefined = c.config.shell;
      expect(shell).toBe("zsh");
      expect(c.config.initialCommand).toBe("ls");
    }
  });

  it("tolerates the legacy shellType alias on a local config", () => {
    const c = cfg("local", { shellType: "bash" });
    if (isLocalConnectionConfig(c)) {
      expect(c.config.shell ?? c.config.shellType).toBe("bash");
    }
  });

  it("narrows a wsl config to its distribution field", () => {
    const c = cfg("wsl", { distribution: "Ubuntu" });
    expect(isWslConnectionConfig(c)).toBe(true);
    if (isWslConnectionConfig(c)) {
      const distro: string | undefined = c.config.distribution;
      expect(distro).toBe("Ubuntu");
    }
  });

  it("narrows an ssh config and exposes the proxyJump chain", () => {
    const c = cfg("ssh", {
      host: "db",
      port: 22,
      username: "deploy",
      proxyJump: [{ host: "bastion", port: 22, username: "j", authMethod: "agent" }],
    });
    expect(isSshConnectionConfig(c)).toBe(true);
    if (isSshConnectionConfig(c)) {
      expect(c.config.host).toBe("db");
      expect(c.config.port).toBe(22);
      expect(c.config.proxyJump).toHaveLength(1);
      expect(c.config.proxyJump?.[0].host).toBe("bastion");
    }
  });

  it("recognises serial, telnet and docker configs", () => {
    expect(isSerialConnectionConfig(cfg("serial", { port: "/dev/ttyUSB0" }))).toBe(true);
    expect(isTelnetConnectionConfig(cfg("telnet", { host: "h", port: 23 }))).toBe(true);
    expect(isDockerConnectionConfig(cfg("docker", { image: "alpine:3" }))).toBe(true);
  });

  it("returns false for a mismatched type", () => {
    expect(isLocalConnectionConfig(cfg("ssh"))).toBe(false);
    expect(isSshConnectionConfig(cfg("local"))).toBe(false);
  });

  it("returns false for a schema-driven / plugin type (falls through to the untyped bag)", () => {
    const plugin = cfg("acme-custom", { endpoint: "wss://acme.example" });
    expect(isLocalConnectionConfig(plugin)).toBe(false);
    expect(isSshConnectionConfig(plugin)).toBe(false);
    expect(isDockerConnectionConfig(plugin)).toBe(false);
  });

  it("returns false for null / undefined", () => {
    expect(isLocalConnectionConfig(null)).toBe(false);
    expect(isSshConnectionConfig(undefined)).toBe(false);
  });
});
