import { describe, it, expect } from "vitest";
import type { InstalledPlugin } from "@/types/plugin";
import type { PluginSandboxStatus, PluginSandboxView } from "@/store/pluginSandboxBridge";
import {
  accessChips,
  isolationBadge,
  missingLayerWarning,
  processLabel,
} from "./nativePluginSandbox";

function plugin(overrides: Record<string, unknown> = {}): InstalledPlugin {
  return {
    manifest: {
      id: "p",
      name: "P",
      version: "1.0.0",
      permissions: ["terminal"],
      ...overrides,
    },
    state: "active",
    installedAt: 0,
  } as unknown as InstalledPlugin;
}

const sandboxed: PluginSandboxView = { outOfProcess: true, plugins: {} };

function status(overrides: Partial<PluginSandboxStatus>): PluginSandboxStatus {
  return { isolation: "full", enforced: [], missing: [], denials: [], ...overrides };
}

describe("nativePluginSandbox helpers", () => {
  it("has no badge for an untrusted plugin", () => {
    expect(isolationBadge(plugin(), undefined, sandboxed, false)).toBeUndefined();
  });

  it("maps every isolation to its badge", () => {
    const cases: [PluginSandboxStatus["isolation"], string, string][] = [
      ["full", "Isolated", "ok"],
      ["reduced", "Reduced isolation (accepted)", "warning"],
      ["unconfined", "Not sandboxed", "checking"],
      ["unavailable", "Isolation unavailable on this system", "warning"],
      ["failed", "Could not start the plugin sandbox", "error"],
      ["runnerMissing", "Plugin runner is missing — reinstall termiHub", "error"],
    ];
    for (const [isolation, label, tone] of cases) {
      const badge = isolationBadge(plugin(), status({ isolation }), sandboxed, true);
      expect(badge?.label).toBe(label);
      expect(badge?.tone).toBe(tone);
    }
  });

  it("puts the crash auto-disable above every other state", () => {
    const badge = isolationBadge(
      plugin(),
      status({
        process: {
          state: "disabled",
          sessions: 0,
          crashes: 4,
          maxRestarts: 3,
          autoDisabled: "Disabled after 3 crashes",
        },
      }),
      sandboxed,
      true
    );
    expect(badge).toMatchObject({ kind: "disabled", label: "Disabled after 3 crashes" });
  });

  it("labels the process states", () => {
    const p = (state: "running" | "idle" | "restarting", sessions = 0, crashes = 0) =>
      processLabel(status({ process: { state, sessions, crashes, maxRestarts: 3 } }));
    expect(p("running")).toBe("Running");
    expect(p("running", 1)).toBe("Running · 1 session");
    expect(p("running", 2, 1)).toBe("Running · 2 sessions · restarted 1/3");
    expect(p("restarting", 0, 2)).toBe("Restarting (2/3)");
    expect(p("idle")).toBe("Idle");
    expect(processLabel(undefined)).toBeUndefined();
  });

  it("names the missing layer in the warning", () => {
    expect(missingLayerWarning(["seccomp"])).toBe(
      "This system cannot restrict network and program access (Linux seccomp is unavailable)."
    );
  });

  it("derives the access chips from the manifest permissions", () => {
    const chips = accessChips(
      plugin({
        permissions: ["terminal", "network", "filesystem"],
        filesystemPaths: ["~/captures"],
        connectionPolicy: { maxConnections: 2 },
      })
    );
    expect(chips.map((c) => [c.id, c.denied])).toEqual([
      ["network", false],
      ["data", false],
      ["declared-files", false],
      ["files", true],
      ["programs", true],
    ]);
    expect(chips[0].rule).toContain("max 2 connections");
    expect(accessChips(plugin()).map((c) => c.id)).toEqual(["data", "files", "programs"]);
  });
});
