/**
 * NativePluginGateSettings (SEC-002 / PLG-006 / ARCH-008): the default-off gate
 * plus per-plugin trust acknowledgment for native (in-process) plugins. These
 * tests pin that the disclosure + global toggle render and reflect the fetched
 * state, that flipping the toggle persists via `setNativePluginsEnabled`, that
 * only native plugins are listed, and that the per-plugin control reflects (and
 * mutates) acknowledgment state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { InstalledPlugin, NativePluginTrust } from "@/types/plugin";
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

let mockSandbox: PluginSandboxView = { outOfProcess: false, plugins: {} };
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
    mockSandbox = { outOfProcess: false, plugins: {} };
    vi.clearAllMocks();
    getNativePluginTrust.mockResolvedValue({
      enabled: false,
      disclosure: "Native plugins run with full application privileges and no OS sandbox.",
      outOfProcess: false,
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
    expect(query("native-plugin-disclosure")!.textContent).toContain("no OS sandbox");
    expect(query("settings-native-plugins-enabled")!.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects the global switch being enabled", async () => {
    getNativePluginTrust.mockResolvedValue({
      enabled: true,
      disclosure: "d",
      outOfProcess: false,
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
      outOfProcess: false,
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
      outOfProcess: false,
      acknowledged: [
        {
          id: "echo",
          librarySha256: "abc",
          acknowledgedAt: "t",
          unverifiedToolchainAccepted: false,
          reducedIsolationAccepted: false,
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
      outOfProcess: false,
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
      outOfProcess: false,
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
      outOfProcess: false,
      acknowledged: [
        {
          id: "old",
          librarySha256: "abc",
          acknowledgedAt: "t",
          unverifiedToolchainAccepted: false,
          reducedIsolationAccepted: false,
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

  describe("sandbox status (#4188)", () => {
    const trustedEcho = {
      enabled: true,
      disclosure: "Native plugins run in a separate, sandboxed process.",
      outOfProcess: true,
      acknowledged: [
        {
          id: "echo",
          librarySha256: "abc",
          acknowledgedAt: "t",
          unverifiedToolchainAccepted: false,
          reducedIsolationAccepted: false,
        },
      ],
    };

    function withStatus(status: Partial<PluginSandboxStatus>) {
      mockSandbox = {
        outOfProcess: true,
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

    it("drops the Advanced framing when plugins run sandboxed", async () => {
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
        "This system cannot restrict file access (Linux Landlock is unavailable). Network and program limits still apply."
      );
      expect(query("native-plugin-load-reduced-echo")).toBeNull();
    });

    it("shows Not sandboxed for an in-process build", async () => {
      mockSandbox = { outOfProcess: false, plugins: {} };
      getNativePluginTrust.mockResolvedValue({ ...trustedEcho, outOfProcess: false });
      await renderFlushed();
      expect(badge()!.textContent).toContain("Not sandboxed");
      expect(query("native-plugin-access-echo")).toBeNull();
      expect(query("native-plugin-process-echo")).toBeNull();
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
      mockSandbox = { outOfProcess: true, plugins: {} };
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
});
