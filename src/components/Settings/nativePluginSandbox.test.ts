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

  describe("missing Landlock warning (#4605)", () => {
    const base = "This system cannot restrict file access (Linux Landlock is unavailable).";

    it("says the home folder stays hidden where the namespace layer is enforced", () => {
      expect(missingLayerWarning(["landlock"], ["seccomp", "netns"])).toBe(
        `${base} Your home folder stays hidden, but the plugin can read and change other files on this system.`
      );
    });

    it("says every file is reachable without the namespace layer", () => {
      const text = missingLayerWarning(["landlock"], ["seccomp"]);
      expect(text).toBe(
        `${base} The plugin can read and change any of your files, including startup scripts, so it can effectively run programs as you.`
      );
      // The old copy overstated the protection.
      expect(text).not.toContain("still apply");
    });

    it("assumes the worst when the enforced layers are unknown", () => {
      expect(missingLayerWarning(["landlock"])).toContain("can read and change any of your files");
    });

    it("adds no file consequence when Landlock is present", () => {
      expect(missingLayerWarning(["seccomp"], ["landlock", "netns"])).toBe(
        "This system cannot restrict network and program access (Linux seccomp is unavailable)."
      );
    });
  });

  describe("files chip per isolation level (#4605)", () => {
    const filesChip = (s?: PluginSandboxStatus, overrides: Record<string, unknown> = {}) =>
      accessChips(plugin(overrides), s).find((c) => c.id === "files");
    const declared = { permissions: ["terminal", "filesystem"], filesystemPaths: ["/data"] };

    it("denies all file access off Linux and without a status", () => {
      expect(filesChip()).toMatchObject({
        rule: "No access to your home folder or other files",
        denied: true,
      });
      expect(filesChip(status({ enforced: ["seatbelt"] }))).toMatchObject({
        rule: "No access to your home folder or other files",
        denied: true,
      });
    });

    it("denies all file access on Linux with Landlock and the namespace layer", () => {
      expect(filesChip(status({ enforced: ["seccomp", "landlock", "netns"] }))).toMatchObject({
        rule: "No access to your home folder or other files",
        denied: true,
      });
    });

    it("notes visible file names and sizes on Linux without the namespace layer", () => {
      const s = status({ enforced: ["seccomp", "landlock"] });
      expect(filesChip(s)).toMatchObject({
        label: "Your files",
        rule: "Cannot open your home folder or other files, but can see their names and sizes",
        denied: true,
      });
      expect(filesChip(s, declared)).toMatchObject({
        label: "Other files",
        rule: "Cannot open files outside the declared folders, but can see their names and sizes",
        denied: true,
      });
    });

    it("says only the home folder is hidden in reduced isolation with the namespace layer", () => {
      const chip = filesChip(
        status({ isolation: "reduced", enforced: ["seccomp", "netns"], missing: ["landlock"] })
      );
      expect(chip).toMatchObject({
        rule: "Your home folder stays hidden; other files on this system can be read and changed",
        denied: false,
      });
    });

    it("grants every file in reduced isolation without the namespace layer", () => {
      const s = status({ isolation: "reduced", enforced: ["seccomp"], missing: ["landlock"] });
      expect(filesChip(s)).toMatchObject({
        rule: "Can read and change any of your files",
        denied: false,
      });
      expect(filesChip(s, declared)?.denied).toBe(false);
    });
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
      ["local-network", true],
      ["data", false],
      ["declared-files", false],
      ["files", true],
      ["programs", true],
    ]);
    expect(chips[0].rule).toContain("max 2 connections");
    expect(accessChips(plugin()).map((c) => c.id)).toEqual(["data", "files", "programs"]);
  });

  it("shows the local-network opt-in as a trust chip (SEC2-005)", () => {
    const denied = accessChips(plugin({ permissions: ["terminal", "network"] })).find(
      (c) => c.id === "local-network"
    );
    expect(denied?.denied).toBe(true);
    expect(denied?.rule).toBe("Cannot reach this computer (localhost) or private networks");

    const allowed = accessChips(
      plugin({
        permissions: ["terminal", "network"],
        connectionPolicy: { allowLocalNetwork: true },
      })
    ).find((c) => c.id === "local-network");
    expect(allowed?.denied).toBe(false);
    expect(allowed?.label).toBe("Local network");
    expect(allowed?.rule).toBe(
      "May reach this computer (localhost) and private networks; cloud metadata stays blocked"
    );

    // Without `network` the opt-in grants nothing, so no chip is shown.
    const noNetwork = accessChips(plugin({ connectionPolicy: { allowLocalNetwork: true } }));
    expect(noNetwork.some((c) => c.id === "local-network")).toBe(false);
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
