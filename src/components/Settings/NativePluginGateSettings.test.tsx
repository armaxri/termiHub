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

const getNativePluginTrust = vi.fn<() => Promise<NativePluginTrust>>();
const setNativePluginsEnabled = vi.fn<(enabled: boolean) => Promise<void>>(() => Promise.resolve());
const acknowledgeNativePlugin = vi.fn<
  (id: string, options?: { acceptUnverifiedToolchain?: boolean }) => Promise<InstalledPlugin>
>(() => Promise.resolve({} as InstalledPlugin));
const revokeNativePluginTrust = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());

vi.mock("@/services/api", () => ({
  getNativePluginTrust: () => getNativePluginTrust(),
  setNativePluginsEnabled: (enabled: boolean) => setNativePluginsEnabled(enabled),
  acknowledgeNativePlugin: (id: string, options?: { acceptUnverifiedToolchain?: boolean }) =>
    acknowledgeNativePlugin(id, options),
  revokeNativePluginTrust: (id: string) => revokeNativePluginTrust(id),
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
    root.render(<NativePluginGateSettings />);
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
    vi.clearAllMocks();
    getNativePluginTrust.mockResolvedValue({
      enabled: false,
      disclosure: "Native plugins run with full application privileges and no OS sandbox.",
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
    getNativePluginTrust.mockResolvedValue({ enabled: true, disclosure: "d", acknowledged: [] });
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
    getNativePluginTrust.mockResolvedValue({ enabled: true, disclosure: "d", acknowledged: [] });
    mockPlugins = [plugin("echo", "Echo", true, "1.1")];
    await renderFlushed();
    expect(query("native-plugin-toolchain-warning-echo")).toBeNull();
    await act(async () => query("native-plugin-trust-echo")!.click());
    expect(acknowledgeNativePlugin).toHaveBeenCalledWith("echo", {
      acceptUnverifiedToolchain: false,
    });
  });

  it("warns that an ABI 1.0 plugin's toolchain is unverifiable and records the acceptance", async () => {
    getNativePluginTrust.mockResolvedValue({ enabled: true, disclosure: "d", acknowledged: [] });
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
});
