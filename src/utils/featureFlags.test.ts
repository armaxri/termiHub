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

  it("falls back to global default when no explicit override is set", () => {
    expect(resolveFeatureEnabled(sshConfig({}), "enableMonitoring", true)).toBe(true);
    expect(resolveFeatureEnabled(sshConfig({}), "enableMonitoring", false)).toBe(false);
    expect(resolveFeatureEnabled(sshConfig({}), "enableFileBrowser", true)).toBe(true);
    expect(resolveFeatureEnabled(sshConfig({}), "enableFileBrowser", false)).toBe(false);
  });

  it("falls back to global default for any config type without explicit override", () => {
    const localConfig: ConnectionConfig = {
      type: "local",
      config: { shellType: "bash" },
    };
    // Without explicit override, falls back to globalDefault.
    // Callers are responsible for checking capabilities before calling.
    expect(resolveFeatureEnabled(localConfig, "enableMonitoring", true)).toBe(true);
    expect(resolveFeatureEnabled(localConfig, "enableMonitoring", false)).toBe(false);
  });

  it("returns false for undefined config", () => {
    expect(resolveFeatureEnabled(undefined, "enableMonitoring", true)).toBe(false);
    expect(resolveFeatureEnabled(undefined, "enableFileBrowser", true)).toBe(false);
  });
});
