import { describe, it, expect } from "vitest";
import { resolveFeatureEnabled } from "./featureFlags";
import { ConnectionConfig } from "@/types/terminal";

const sshConfig = (overrides: {
  enableMonitoring?: boolean;
  enableFileBrowser?: boolean;
}): ConnectionConfig => ({
  type: "ssh",
  config: {
    host: "example.com",
    port: 22,
    username: "admin",
    authMethod: "password" as const,
    ...overrides,
  },
});

describe("resolveFeatureEnabled", () => {
  it("returns explicit true override regardless of global default", () => {
    expect(
      resolveFeatureEnabled(sshConfig({ enableMonitoring: true }), "enableMonitoring", false)
    ).toBe(true);
    expect(
      resolveFeatureEnabled(sshConfig({ enableFileBrowser: true }), "enableFileBrowser", false)
    ).toBe(true);
  });

  it("returns explicit false override regardless of global default", () => {
    expect(
      resolveFeatureEnabled(sshConfig({ enableMonitoring: false }), "enableMonitoring", true)
    ).toBe(false);
    expect(
      resolveFeatureEnabled(sshConfig({ enableFileBrowser: false }), "enableFileBrowser", true)
    ).toBe(false);
  });

  it("falls back to global default when override is undefined", () => {
    expect(resolveFeatureEnabled(sshConfig({}), "enableMonitoring", true)).toBe(true);
    expect(resolveFeatureEnabled(sshConfig({}), "enableMonitoring", false)).toBe(false);
    expect(resolveFeatureEnabled(sshConfig({}), "enableFileBrowser", true)).toBe(true);
    expect(resolveFeatureEnabled(sshConfig({}), "enableFileBrowser", false)).toBe(false);
  });

  it("returns false for non-SSH config", () => {
    const localConfig: ConnectionConfig = {
      type: "local",
      config: { shellType: "bash" },
    };
    expect(resolveFeatureEnabled(localConfig, "enableMonitoring", true)).toBe(false);
    expect(resolveFeatureEnabled(localConfig, "enableFileBrowser", true)).toBe(false);
  });

  it("returns false for undefined config", () => {
    expect(resolveFeatureEnabled(undefined, "enableMonitoring", true)).toBe(false);
    expect(resolveFeatureEnabled(undefined, "enableFileBrowser", true)).toBe(false);
  });

  it("returns false for telnet config", () => {
    const telnetConfig: ConnectionConfig = {
      type: "telnet",
      config: { host: "example.com", port: 23 },
    };
    expect(resolveFeatureEnabled(telnetConfig, "enableMonitoring", true)).toBe(false);
  });
});
