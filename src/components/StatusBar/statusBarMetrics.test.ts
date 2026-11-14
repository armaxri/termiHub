import { describe, it, expect } from "vitest";
import type { ConnectionConfig } from "@/types/terminal";
import {
  DEFAULT_STATUS_BAR_METRICS,
  isMonitoringEnabledForTab,
  resolveStatusBarMetrics,
} from "./statusBarMetrics";

const local = (extra: Record<string, unknown> = {}): ConnectionConfig =>
  ({ type: "local", config: { shell: "zsh", ...extra } }) as ConnectionConfig;
const ssh = (extra: Record<string, unknown> = {}): ConnectionConfig =>
  ({ type: "ssh", config: { host: "h", port: 22, username: "u", ...extra } }) as ConnectionConfig;

describe("resolveStatusBarMetrics (#5754)", () => {
  it("defaults to CPU, memory, disk and network, without swap", () => {
    const shown = resolveStatusBarMetrics(undefined);
    expect([...shown]).toEqual(["cpu", "memory", "disk", "network"]);
    expect(shown.has("swap")).toBe(false);
    expect(DEFAULT_STATUS_BAR_METRICS).not.toContain("swap");
  });

  it("keeps an explicit choice, swap included or nothing at all", () => {
    expect([...resolveStatusBarMetrics(["cpu", "swap"])]).toEqual(["cpu", "swap"]);
    expect(resolveStatusBarMetrics([]).size).toBe(0);
  });
});

describe("isMonitoringEnabledForTab (#5754)", () => {
  const base = { globalEnabled: true, monitorLocalShells: undefined };

  it("keeps local shells off by default", () => {
    expect(isMonitoringEnabledForTab({ ...base, connectionType: "local", config: local() })).toBe(
      false
    );
  });

  it("monitors local shells once the user opts in, under the global switch", () => {
    const optIn = { connectionType: "local", config: local(), monitorLocalShells: true };
    expect(isMonitoringEnabledForTab({ ...optIn, globalEnabled: true })).toBe(true);
    expect(isMonitoringEnabledForTab({ ...optIn, globalEnabled: false })).toBe(false);
  });

  it("keeps a connection's explicit enableMonitoring", () => {
    expect(
      isMonitoringEnabledForTab({
        ...base,
        connectionType: "local",
        config: local({ enableMonitoring: true }),
      })
    ).toBe(true);
    expect(
      isMonitoringEnabledForTab({
        ...base,
        connectionType: "ssh",
        config: ssh({ enableMonitoring: false }),
      })
    ).toBe(false);
  });

  it("monitors remote sessions by the global default", () => {
    expect(isMonitoringEnabledForTab({ ...base, connectionType: "ssh", config: ssh() })).toBe(true);
    expect(
      isMonitoringEnabledForTab({
        ...base,
        globalEnabled: false,
        connectionType: "ssh",
        config: ssh(),
      })
    ).toBe(false);
  });

  it("is off without a config", () => {
    expect(isMonitoringEnabledForTab({ ...base, connectionType: "ssh", config: undefined })).toBe(
      false
    );
  });
});
