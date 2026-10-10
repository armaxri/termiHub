/**
 * NativePluginGateSettings (SEC-002 / PLG-006 / ARCH-008): the default-off gate
 * plus per-plugin trust acknowledgment for native plugins. These
 * tests pin that the disclosure + global toggle render and reflect the fetched
 * state, that flipping the toggle persists via `setNativePluginsEnabled`, that
 * only native plugins are listed, and that the per-plugin control reflects (and
 * mutates) acknowledgment state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { InstalledPlugin, NativePluginTrust } from "@/types/plugin";
import type { NativeAckInfo } from "@/types/generated/NativeAckInfo";
import type { PluginSandboxStatus, PluginSandboxView } from "@/store/pluginSandboxBridge";

const getNativePluginTrust = vi.fn<() => Promise<NativePluginTrust>>();
const setNativePluginsEnabled = vi.fn<(enabled: boolean) => Promise<void>>(() => Promise.resolve());
const acknowledgeNativePlugin = vi.fn<
  (id: string, options?: { acceptUnverifiedToolchain?: boolean }) => Promise<InstalledPlugin>
>(() => Promise.resolve({} as InstalledPlugin));
const revokeNativePluginTrust = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
const enablePlugin = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());

vi.mock("@/services/api", () => ({
  getNativePluginTrust: () => getNativePluginTrust(),
  setNativePluginsEnabled: (enabled: boolean) => setNativePluginsEnabled(enabled),
  acknowledgeNativePlugin: (id: string, options?: { acceptUnverifiedToolchain?: boolean }) =>
    acknowledgeNativePlugin(id, options),
  revokeNativePluginTrust: (id: string) => revokeNativePluginTrust(id),
  enablePlugin: (id: string) => enablePlugin(id),
}));

let mockSandbox: PluginSandboxView = { plugins: {} };
vi.mock("@/store/usePluginSandbox", () => ({
  usePluginSandbox: () => mockSandbox,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

let mockPlugins: InstalledPlugin[] = [];
vi.mock("@/store/appStore", () => ({
  useAppStore: <T,>(selector: (s: { plugins: InstalledPlugin[] }) => T): T =>
    selector({ plugins: mockPlugins }),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { success: vi.fn(), error: vi.fn() } };
});

import { TooltipProvider } from "@/components/ui";
import { NativePluginGateSettings } from "./NativePluginGateSettings";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

/**
 * Build a minimal installed-plugin record; `native` decides the terminalBackend,
 * `apiVersion` the native ABI it was built for.
 */
function plugin(id: string, name: string, native: boolean, apiVersion = "1.1"): InstalledPlugin {
  return {
    manifest: {
      id,
      name,
      version: "1.0.0",
      author: "t",
      description: "",
      license: "MIT",
      apiVersion,
      platforms: ["linux"],
      permissions: native ? ["terminal"] : [],
      extensions: native
        ? { terminalBackend: { connectionType: id, displayName: name, configSchema: {} } }
        : { theme: { themes: [] } },
    },
    state: "installed",
    installedAt: 0,
  } as unknown as InstalledPlugin;
}

async function renderFlushed() {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <NativePluginGateSettings />
      </TooltipProvider>
    );
  });
  // Flush the async initial load (getNativePluginTrust → setTrust).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("NativePluginGateSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockPlugins = [];
    mockSandbox = { plugins: {} };
    vi.clearAllMocks();
    getNativePluginTrust.mockResolvedValue({
      enabled: false,
      disclosure: "Native plugins run in a separate, sandboxed process.",
      acknowledged: [],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the disclosure and a default-off global toggle", async () => {
    await renderFlushed();
    expect(query("settings-native-plugin-gate")).not.toBeNull();
    expect(query("native-plugin-disclosure")!.textContent).toContain("sandboxed process");
    expect(query("settings-native-plugins-enabled")!.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects the global switch being enabled", async () => {
    getNativePluginTrust.mockResolvedValue({
      enabled: true,
      disclosure: "d",
      acknowledged: [],
    });
    await renderFlushed();
    expect(query("settings-native-plugins-enabled")!.getAttribute("aria-checked")).toBe("true");
  });

  it("persists the global switch when toggled on", async () => {
    await renderFlushed();
    await act(async () => query("settings-native-plugins-enabled")!.click());
    expect(setNativePluginsEnabled).toHaveBeenCalledWith(true);
  });

  it("lists only native plugins and shows a Trust control when unacknowledged", async () => {
    getNativePluginTrust.mockResolvedValue({
      enabled: true,
      disclosure: "d",
      acknowledged: [],
    });
    mockPlugins = [plugin("echo", "Echo", true), plugin("dark", "Dark Theme", false)];
    await renderFlushed();
    // Native plugin listed with a Trust control; the theme plugin is not listed.
    expect(query("native-plugin-row-echo")).not.toBeNull();
    expect(query("native-plugin-row-dark")).toBeNull();
    expect(query("native-plugin-trust-echo")).not.toBeNull();
    expect(query("native-plugin-revoke-echo")).toBeNull();
  });

  it("shows a Revoke control for an acknowledged native plugin and revokes it", async () => {
    getNativePluginTrust.mockResolvedValue({
      enabled: true,
      disclosure: "d",
      acknowledged: [
        {
          id: "echo",
          librarySha256: "abc",
          acknowledgedAt: "t",
          unverifiedToolchainAccepted: false,
          reducedIsolationAccepted: false,
          state: "current",
          addedAccess: [],
        },
      ],
    });
    mockPlugins = [plugin("echo", "Echo", true)];
    await renderFlushed();
    const revoke = query("native-plugin-revoke-echo");
    expect(revoke).not.toBeNull();
    expect(query("native-plugin-trust-echo")).toBeNull();
    await act(async () => revoke!.click());
    expect(revokeNativePluginTrust).toHaveBeenCalledWith("echo");
  });

  it("trusts an ABI 1.1 plugin without accepting an unverified toolchain", async () => {
    getNativePluginTrust.mockResolvedValue({
      enabled: true,
      disclosure: "d",
      acknowledged: [],
    });
    mockPlugins = [plugin("echo", "Echo", true, "1.1")];
    await renderFlushed();
    expect(query("native-plugin-toolchain-warning-echo")).toBeNull();
    await act(async () => query("native-plugin-trust-echo")!.click());
    expect(acknowledgeNativePlugin).toHaveBeenCalledWith("echo", {
      acceptUnverifiedToolchain: false,
    });
  });

  it("warns that an ABI 1.0 plugin's toolchain is unverifiable and records the acceptance", async () => {
    getNativePluginTrust.mockResolvedValue({
      enabled: true,
      disclosure: "d",
      acknowledged: [],
    });
    mockPlugins = [plugin("old", "Old", true, "1.0")];
    await renderFlushed();
    expect(query("native-plugin-toolchain-warning-old")!.textContent).toContain("cannot verify");
    await act(async () => query("native-plugin-trust-old")!.click());
    expect(acknowledgeNativePlugin).toHaveBeenCalledWith("old", {
      acceptUnverifiedToolchain: true,
    });
  });

  it("offers Trust again for an ABI 1.0 plugin trusted without the toolchain acceptance", async () => {
    getNativePluginTrust.mockResolvedValue({
      enabled: true,
      disclosure: "d",
      acknowledged: [
        {
          id: "old",
          librarySha256: "abc",
          acknowledgedAt: "t",
          unverifiedToolchainAccepted: false,
          reducedIsolationAccepted: false,
          state: "current",
          addedAccess: [],
        },
      ],
    });
    mockPlugins = [plugin("old", "Old", true, "1.0")];
    await renderFlushed();
    // The host refuses it until the acceptance is recorded, so it is not
    // shown as trusted and the Trust control is offered again.
    expect(query("native-plugin-trust-old")).not.toBeNull();
    expect(query("native-plugin-revoke-old")).toBeNull();
  });

  describe("stale acknowledgement (#4294)", () => {
    function ackIn(state: NativeAckInfo["state"], addedAccess: string[] = []): NativePluginTrust {
      return {
        enabled: true,
        disclosure: "d",
        acknowledged: [
          {
            id: "echo",
            librarySha256: "abc",
            acknowledgedAt: "t",
            unverifiedToolchainAccepted: false,
            reducedIsolationAccepted: false,
            state,
            addedAccess,
          },
        ],
      };
    }

    beforeEach(() => {
      mockPlugins = [
        {
          ...plugin("echo", "Echo", true),
          manifest: {
            ...plugin("echo", "Echo", true).manifest,
            permissions: ["terminal", "network"],
          },
        } as InstalledPlugin,
      ];
      mockSandbox = {
        plugins: {
          echo: { isolation: "full", enforced: ["seatbelt"], missing: [], denials: [] },
        },
      };
    });

    function rowText(): string {
      return query("native-plugin-row-echo")!.textContent ?? "";
    }

    it("shows widened access as needing re-approval, with a review action", async () => {
      getNativePluginTrust.mockResolvedValue(ackIn("accessChanged", ["network"]));
      await renderFlushed();
      expect(rowText()).toContain("needs re-approval");
      expect(rowText()).not.toContain("· trusted");
      // No isolation badge: a stale plugin does not load.
      expect(query("native-plugin-isolation-echo")).toBeNull();
      expect(query("native-plugin-stale-echo")!.textContent).toContain(
        "Permissions changed — review"
      );
      expect(query("native-plugin-stale-echo")!.textContent).toContain("network");
      const review = query("native-plugin-trust-echo")!;
      expect(review.textContent).toContain("Permissions changed — review");
      // Revoke stays available for a stale acknowledgement.
      expect(query("native-plugin-revoke-echo")).not.toBeNull();

      // Review opens a dialog listing the access; nothing is trusted until confirmed.
      await act(async () => review.click());
      expect(acknowledgeNativePlugin).not.toHaveBeenCalled();
      expect(
        (document.querySelector(
          '[data-testid="native-plugin-review-dialog-echo"]'
        ) as HTMLElement | null)!.textContent
      ).toContain("New since you approved it: network");
      expect(
        (document.querySelector(
          '[data-testid="native-plugin-review-access-echo"]'
        ) as HTMLElement | null)!.textContent
      ).toContain("Network via termiHub");
      await act(async () =>
        (document.querySelector(
          '[data-testid="native-plugin-review-echo-confirm"]'
        ) as HTMLElement | null)!.click()
      );
      expect(acknowledgeNativePlugin).toHaveBeenCalledWith("echo", {
        acceptUnverifiedToolchain: false,
      });
    });

    it("treats an acknowledgement without recorded access as untrusted", async () => {
      getNativePluginTrust.mockResolvedValue(ackIn("accessNotRecorded", ["terminal", "network"]));
      await renderFlushed();
      expect(rowText()).toContain("needs re-approval");
      expect(query("native-plugin-stale-echo")!.textContent).toContain(
        "Permissions changed — review"
      );
      expect(query("native-plugin-trust-echo")!.textContent).toContain(
        "Permissions changed — review"
      );
    });

    it("offers Trust new build when only the library changed", async () => {
      getNativePluginTrust.mockResolvedValue(ackIn("libraryChanged"));
      await renderFlushed();
      expect(rowText()).toContain("needs re-approval");
      expect(query("native-plugin-stale-echo")!.textContent).toContain(
        "changed since you trusted it"
      );
      const trust = query("native-plugin-trust-echo")!;
      expect(trust.textContent).toContain("Trust new build");
      await act(async () => trust.click());
      expect(acknowledgeNativePlugin).toHaveBeenCalledWith("echo", {
        acceptUnverifiedToolchain: false,
      });
    });

    it("never offers trust for a plugin termiHub cannot read", async () => {
      getNativePluginTrust.mockResolvedValue(ackIn("unavailable"));
      await renderFlushed();
      expect(rowText()).toContain("needs re-approval");
      expect(query("native-plugin-trust-echo")).toBeNull();
      expect(query("native-plugin-revoke-echo")).not.toBeNull();
    });

    it("shows a current acknowledgement as trusted", async () => {
      getNativePluginTrust.mockResolvedValue(ackIn("current"));
      await renderFlushed();
      expect(rowText()).toContain("· trusted");
      expect(query("native-plugin-stale-echo")).toBeNull();
      expect(query("native-plugin-trust-echo")).toBeNull();
    });
  });

  describe("sandbox status (#4188)", () => {
    const trustedEcho = {
      enabled: true,
      disclosure: "Native plugins run in a separate, sandboxed process.",
      acknowledged: [
        {
          id: "echo",
          librarySha256: "abc",
          acknowledgedAt: "t",
          unverifiedToolchainAccepted: false,
          reducedIsolationAccepted: false,
          state: "current" as const,
          addedAccess: [],
        },
      ],
    };

    function withStatus(status: Partial<PluginSandboxStatus>) {
      mockSandbox = {
        plugins: {
          echo: { isolation: "full", enforced: [], missing: [], denials: [], ...status },
        },
      };
    }

    function badge(): HTMLElement | null {
      return query("native-plugin-isolation-echo");
    }

    beforeEach(() => {
      getNativePluginTrust.mockResolvedValue(trustedEcho);
      mockPlugins = [plugin("echo", "Echo", true)];
    });

    it("titles the section Native Plugins without an Advanced framing", async () => {
      withStatus({ isolation: "full", enforced: ["seatbelt"] });
      await renderFlushed();
      const section = query("settings-native-plugin-gate")!;
      expect(section.querySelector("h3")!.textContent).toBe(" Native Plugins");
      expect(query("native-plugin-disclosure")!.textContent).toContain("sandboxed process");
    });

    it("shows Isolated, the process status and the access chips for a full sandbox", async () => {
      withStatus({
        isolation: "full",
        enforced: ["seatbelt"],
        process: { state: "running", sessions: 2, crashes: 0, maxRestarts: 3 },
      });
      mockPlugins = [
        {
          ...plugin("echo", "Echo", true),
          manifest: {
            ...plugin("echo", "Echo", true).manifest,
            permissions: ["terminal", "network"],
          },
        } as InstalledPlugin,
      ];
      await renderFlushed();
      expect(badge()!.textContent).toContain("Isolated");
      expect(badge()!.className).toContain("--ok");
      expect(query("native-plugin-process-echo")!.textContent).toContain("Running · 2 sessions");
      expect(query("native-plugin-access-echo-network")!.textContent).toBe("Network via termiHub");
      const programs = query("native-plugin-access-echo-programs")!;
      expect(programs.className).toContain("ui-chip--denied");
      expect(query("native-plugin-restart-echo")!.textContent).toContain("Restart");
    });

    it("shows Reduced isolation (accepted) with the missing layer", async () => {
      withStatus({ isolation: "reduced", enforced: ["seccomp"], missing: ["landlock"] });
      await renderFlushed();
      expect(badge()!.textContent).toContain("Reduced isolation (accepted)");
      expect(badge()!.className).toContain("--warning");
      expect(query("native-plugin-isolation-warning-echo")!.textContent).toBe(
        "This system cannot restrict file access (Linux Landlock is unavailable). The plugin can read and change any of your files, including startup scripts, so it can effectively run programs as you."
      );
      expect(query("native-plugin-load-reduced-echo")).toBeNull();
    });

    it("does not strike the files chip through when reduced isolation exposes them (#4605)", async () => {
      withStatus({ isolation: "reduced", enforced: ["seccomp"], missing: ["landlock"] });
      await renderFlushed();
      expect(query("native-plugin-access-echo-files")!.className).not.toContain("ui-chip--denied");
    });

    it("keeps the home folder hidden in the warning when the namespace layer works (#4605)", async () => {
      withStatus({ isolation: "reduced", enforced: ["seccomp", "netns"], missing: ["landlock"] });
      await renderFlushed();
      expect(query("native-plugin-isolation-warning-echo")!.textContent).toContain(
        "Your home folder stays hidden"
      );
    });

    it("shows Not sandboxed for a runner without OS confinement", async () => {
      withStatus({
        isolation: "unconfined",
        process: { state: "idle", sessions: 0, crashes: 0, maxRestarts: 3 },
      });
      await renderFlushed();
      expect(badge()!.textContent).toContain("Not sandboxed");
      expect(query("native-plugin-process-echo")!.textContent).toContain("Idle");
    });

    it("shows the sandbox-failed state with its log detail", async () => {
      withStatus({ isolation: "failed", detail: "landlock_restrict_self: EPERM" });
      await renderFlushed();
      expect(badge()!.textContent).toContain("Could not start the plugin sandbox");
      expect(badge()!.className).toContain("--error");
      expect(query("native-plugin-sandbox-detail-echo")!.textContent).toContain("EPERM");
    });

    it("shows the runner-missing state", async () => {
      withStatus({ isolation: "runnerMissing", detail: "not found" });
      await renderFlushed();
      expect(badge()!.textContent).toContain("Plugin runner is missing — reinstall termiHub");
    });

    it("shows Disabled after 3 crashes with Re-enable, which re-enables the plugin", async () => {
      mockSandbox = { plugins: {} };
      mockPlugins = [
        {
          ...plugin("echo", "Echo", true),
          state: "disabled",
          errorMessage: "Disabled after 3 crashes",
        } as InstalledPlugin,
      ];
      await renderFlushed();
      expect(badge()!.textContent).toContain("Disabled after 3 crashes");
      expect(badge()!.className).toContain("--error");
      const reenable = query("native-plugin-restart-echo")!;
      expect(reenable.textContent).toContain("Re-enable");
      await act(async () => reenable.click());
      expect(enablePlugin).toHaveBeenCalledWith("echo");
    });

    it("shows Restarting (n/3) while a crashed runner restarts", async () => {
      withStatus({
        isolation: "full",
        process: {
          state: "restarting",
          sessions: 0,
          crashes: 1,
          maxRestarts: 3,
          lastExit: { kind: "crashed", message: "plugin process exited: signal SIGSEGV" },
        },
      });
      await renderFlushed();
      expect(query("native-plugin-process-echo")!.textContent).toContain("Restarting (1/3)");
    });

    it("requires the reduced-isolation acknowledgement before loading", async () => {
      withStatus({ isolation: "unavailable", missing: ["landlock"] });
      await renderFlushed();
      expect(badge()!.textContent).toContain("Isolation unavailable on this system");
      expect(query("native-plugin-isolation-warning-echo")!.textContent).toContain("Landlock");
      await act(async () => query("native-plugin-load-reduced-echo")!.click());
      // A confirmation names the missing layer before anything is recorded.
      const dialog = document.querySelector('[data-testid="native-plugin-reduced-dialog-echo"]')!;
      expect(dialog.textContent).toContain("cannot restrict file access");
      expect(acknowledgeNativePlugin).not.toHaveBeenCalled();
      await act(async () => {
        (
          document.querySelector(
            '[data-testid="native-plugin-reduced-echo-confirm"]'
          ) as HTMLElement
        ).click();
      });
      expect(acknowledgeNativePlugin).toHaveBeenCalledWith("echo", {
        acceptUnverifiedToolchain: false,
        acceptReducedIsolation: true,
      });
    });

    it("does not record the acceptance when the dialog is cancelled", async () => {
      withStatus({ isolation: "unavailable", missing: ["landlock"] });
      await renderFlushed();
      await act(async () => query("native-plugin-load-reduced-echo")!.click());
      await act(async () => {
        (
          document.querySelector('[data-testid="native-plugin-reduced-echo-cancel"]') as HTMLElement
        ).click();
      });
      expect(acknowledgeNativePlugin).not.toHaveBeenCalled();
    });

    it("lists recent denials, including kernel-level system calls (#4247)", async () => {
      withStatus({
        isolation: "full",
        denials: [
          { operation: "connect", target: "", reason: "syscall", atMs: 1, count: 4 },
          {
            operation: "open_connection",
            target: "10.0.0.12:502",
            reason: "permission",
            atMs: 2,
            count: 1,
          },
        ],
      });
      await renderFlushed();
      const items = Array.from(query("native-plugin-denials-echo")!.querySelectorAll("li")).map(
        (li) => li.textContent
      );
      expect(items).toEqual([
        "Blocked system call: connect (×4)",
        "Blocked open_connection 10.0.0.12:502",
      ]);
    });
  });

  describe("ending open sessions (#4379)", () => {
    const trustedEcho: NativePluginTrust = {
      enabled: true,
      disclosure: "d",
      acknowledged: [
        {
          id: "echo",
          librarySha256: "abc",
          acknowledgedAt: "t",
          unverifiedToolchainAccepted: false,
          reducedIsolationAccepted: false,
          state: "current",
          addedAccess: [],
        },
      ],
    };

    function running(sessions: number) {
      mockSandbox = {
        plugins: {
          echo: {
            isolation: "full",
            enforced: ["seatbelt"],
            missing: [],
            denials: [],
            process: { state: "running", sessions, crashes: 0, maxRestarts: 3 },
          },
        },
      };
    }

    function inDoc(testId: string): HTMLElement | null {
      return document.querySelector(`[data-testid="${testId}"]`);
    }

    beforeEach(() => {
      getNativePluginTrust.mockResolvedValue(trustedEcho);
      mockPlugins = [plugin("echo", "Echo", true)];
    });

    it("asks before Restart ends open sessions, and Cancel leaves the plugin running", async () => {
      running(2);
      await renderFlushed();
      await act(async () => query("native-plugin-restart-echo")!.click());
      expect(enablePlugin).not.toHaveBeenCalled();
      const dialog = inDoc("native-plugin-end-sessions-dialog-echo")!;
      expect(dialog.textContent).toContain("Restart Echo?");
      expect(dialog.textContent).toContain("2 open sessions");
      await act(async () => inDoc("native-plugin-end-sessions-echo-cancel")!.click());
      expect(enablePlugin).not.toHaveBeenCalled();
      expect(inDoc("native-plugin-end-sessions-dialog-echo")).toBeNull();
    });

    it("restarts once the user confirms", async () => {
      running(1);
      await renderFlushed();
      await act(async () => query("native-plugin-restart-echo")!.click());
      expect(inDoc("native-plugin-end-sessions-dialog-echo")!.textContent).toContain(
        "1 open session."
      );
      await act(async () => inDoc("native-plugin-end-sessions-echo-confirm")!.click());
      expect(enablePlugin).toHaveBeenCalledWith("echo");
    });

    it("restarts immediately when the plugin has no open sessions", async () => {
      running(0);
      await renderFlushed();
      await act(async () => query("native-plugin-restart-echo")!.click());
      expect(inDoc("native-plugin-end-sessions-dialog-echo")).toBeNull();
      expect(enablePlugin).toHaveBeenCalledWith("echo");
    });

    it("asks before Revoke ends open sessions, and Cancel keeps the trust", async () => {
      running(3);
      await renderFlushed();
      await act(async () => query("native-plugin-revoke-echo")!.click());
      expect(revokeNativePluginTrust).not.toHaveBeenCalled();
      const dialog = inDoc("native-plugin-end-sessions-dialog-echo")!;
      expect(dialog.textContent).toContain("Revoke trust for Echo?");
      expect(dialog.textContent).toContain("3 open sessions");
      await act(async () => inDoc("native-plugin-end-sessions-echo-cancel")!.click());
      expect(revokeNativePluginTrust).not.toHaveBeenCalled();
    });

    it("revokes once the user confirms", async () => {
      running(3);
      await renderFlushed();
      await act(async () => query("native-plugin-revoke-echo")!.click());
      await act(async () => inDoc("native-plugin-end-sessions-echo-confirm")!.click());
      expect(revokeNativePluginTrust).toHaveBeenCalledWith("echo");
    });

    it("revokes immediately when the plugin has no open sessions", async () => {
      running(0);
      await renderFlushed();
      await act(async () => query("native-plugin-revoke-echo")!.click());
      expect(inDoc("native-plugin-end-sessions-dialog-echo")).toBeNull();
      expect(revokeNativePluginTrust).toHaveBeenCalledWith("echo");
    });

    it("asks before the global switch ends open sessions, summing every plugin", async () => {
      mockPlugins = [plugin("echo", "Echo", true), plugin("modbus", "Modbus", true)];
      mockSandbox = {
        plugins: {
          echo: {
            isolation: "full",
            enforced: [],
            missing: [],
            denials: [],
            process: { state: "running", sessions: 2, crashes: 0, maxRestarts: 3 },
          },
          modbus: {
            isolation: "full",
            enforced: [],
            missing: [],
            denials: [],
            process: { state: "running", sessions: 1, crashes: 0, maxRestarts: 3 },
          },
        },
      };
      await renderFlushed();
      await act(async () => query("settings-native-plugins-enabled")!.click());
      expect(setNativePluginsEnabled).not.toHaveBeenCalled();
      expect(inDoc("native-plugins-disable-dialog")!.textContent).toContain("3 open sessions");
      await act(async () => inDoc("native-plugins-disable-cancel")!.click());
      expect(setNativePluginsEnabled).not.toHaveBeenCalled();
      expect(query("settings-native-plugins-enabled")!.getAttribute("aria-checked")).toBe("true");

      await act(async () => query("settings-native-plugins-enabled")!.click());
      await act(async () => inDoc("native-plugins-disable-confirm")!.click());
      expect(setNativePluginsEnabled).toHaveBeenCalledWith(false);
    });

    it("disables native plugins immediately when no plugin has open sessions", async () => {
      running(0);
      await renderFlushed();
      await act(async () => query("settings-native-plugins-enabled")!.click());
      expect(inDoc("native-plugins-disable-dialog")).toBeNull();
      expect(setNativePluginsEnabled).toHaveBeenCalledWith(false);
    });
  });
});
