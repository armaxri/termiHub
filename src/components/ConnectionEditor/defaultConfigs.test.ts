import { describe, it, expect } from "vitest";
import { getDefaultConfigs, getDefaultAgentConfig } from "./defaultConfigs";
import { AppSettings } from "@/types/connection";
import { SshConfig } from "@/types/terminal";

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    version: "1",
    externalConnectionFiles: [],
    powerMonitoringEnabled: true,
    fileBrowserEnabled: true,
    ...overrides,
  };
}

describe("getDefaultConfigs", () => {
  it("returns empty username and password auth when no settings provided", () => {
    const configs = getDefaultConfigs("bash");
    const ssh = configs.ssh!;
    expect(ssh.type).toBe("ssh");
    const cfg = ssh.config as SshConfig;
    expect(cfg.username).toBe("");
    expect(cfg.authMethod).toBe("password");
    expect(cfg.keyPath).toBeUndefined();
  });

  it("returns empty username and password auth when settings has no defaults", () => {
    const configs = getDefaultConfigs("bash", makeSettings());
    const cfg = configs.ssh!.config as SshConfig;
    expect(cfg.username).toBe("");
    expect(cfg.authMethod).toBe("password");
    expect(cfg.keyPath).toBeUndefined();
  });

  it("populates username from defaultUser", () => {
    const configs = getDefaultConfigs("bash", makeSettings({ defaultUser: "admin" }));
    const cfg = configs.ssh!.config as SshConfig;
    expect(cfg.username).toBe("admin");
    expect(cfg.authMethod).toBe("password");
    expect(cfg.keyPath).toBeUndefined();
  });

  it("switches to key auth and populates keyPath from defaultSshKeyPath", () => {
    const configs = getDefaultConfigs(
      "bash",
      makeSettings({ defaultSshKeyPath: "/home/user/.ssh/id_rsa" })
    );
    const cfg = configs.ssh!.config as SshConfig;
    expect(cfg.authMethod).toBe("key");
    expect(cfg.keyPath).toBe("/home/user/.ssh/id_rsa");
    expect(cfg.username).toBe("");
  });

  it("applies both defaultUser and defaultSshKeyPath", () => {
    const configs = getDefaultConfigs(
      "bash",
      makeSettings({ defaultUser: "deploy", defaultSshKeyPath: "/keys/id_ed25519" })
    );
    const cfg = configs.ssh!.config as SshConfig;
    expect(cfg.username).toBe("deploy");
    expect(cfg.authMethod).toBe("key");
    expect(cfg.keyPath).toBe("/keys/id_ed25519");
  });

  it("does not affect non-SSH connection types", () => {
    const configs = getDefaultConfigs(
      "powershell",
      makeSettings({ defaultUser: "admin", defaultSshKeyPath: "/keys/id" })
    );

    expect(configs.local!.config).toEqual({ shellType: "powershell" });
    expect(configs.telnet!.config).toEqual({ host: "", port: 23 });
    expect(configs.serial!.config).toEqual({
      port: "",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    });
  });

  it("uses defaultShell for local config", () => {
    const configs = getDefaultConfigs("zsh");
    expect(configs.local!.config).toEqual({ shellType: "zsh" });
  });
});

describe("getDefaultAgentConfig", () => {
  it("returns empty username and password auth when no settings provided", () => {
    const config = getDefaultAgentConfig();
    expect(config.host).toBe("");
    expect(config.port).toBe(22);
    expect(config.username).toBe("");
    expect(config.authMethod).toBe("password");
    expect(config.keyPath).toBeUndefined();
  });

  it("populates username from defaultUser", () => {
    const config = getDefaultAgentConfig(makeSettings({ defaultUser: "pi" }));
    expect(config.username).toBe("pi");
    expect(config.authMethod).toBe("password");
  });

  it("switches to key auth and populates keyPath from defaultSshKeyPath", () => {
    const config = getDefaultAgentConfig(
      makeSettings({ defaultSshKeyPath: "/home/user/.ssh/id_ed25519" })
    );
    expect(config.authMethod).toBe("key");
    expect(config.keyPath).toBe("/home/user/.ssh/id_ed25519");
  });

  it("applies both defaultUser and defaultSshKeyPath", () => {
    const config = getDefaultAgentConfig(
      makeSettings({ defaultUser: "agent", defaultSshKeyPath: "/keys/key" })
    );
    expect(config.username).toBe("agent");
    expect(config.authMethod).toBe("key");
    expect(config.keyPath).toBe("/keys/key");
  });
});
