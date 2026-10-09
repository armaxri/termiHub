import { describe, it, expect } from "vitest";
import type { InstalledPlugin } from "@/types/plugin";
import type { PluginSandboxStatus } from "@/store/pluginSandboxBridge";
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

function status(overrides: Partial<PluginSandboxStatus>): PluginSandboxStatus {
  return { isolation: "full", enforced: [], missing: [], denials: [], ...overrides };
}

describe("nativePluginSandbox helpers", () => {
  it("has no badge for an untrusted plugin", () => {
    expect(isolationBadge(plugin(), undefined, false)).toBeUndefined();
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
      const badge = isolationBadge(plugin(), status({ isolation }), true);
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

  it("lists the optional netns layer among the enforced layers (#4237)", () => {
    const badge = isolationBadge(
      plugin(),
      status({ isolation: "full", enforced: ["seccomp", "landlock", "netns"] }),
      true
    );
    expect(badge?.kind).toBe("isolated");
    expect(badge?.detail).toBe("Enforced: Linux seccomp, Linux Landlock, Linux network namespace");
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
        filesystemPaths: ["/Users/someone/captures", "/var/log/app"],
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

  it("lists every declared folder on its own line and rewords the files denial", () => {
    const chips = accessChips(
      plugin({
        permissions: ["terminal", "filesystem"],
        filesystemPaths: ["/Users/someone/captures", "/var/log/app"],
      })
    );
    const declared = chips.find((c) => c.id === "declared-files");
    expect(declared?.rule).toBe("Through termiHub only:\n/Users/someone/captures\n/var/log/app");
    const files = chips.find((c) => c.id === "files");
    expect(files?.label).toBe("Other files");
    expect(files?.rule).toBe("No access to files outside the declared folders");
    expect(files?.rule).not.toContain("home folder");

    const none = accessChips(plugin()).find((c) => c.id === "files");
    expect(none?.rule).toBe("No access to your home folder or other files");
  });
});
