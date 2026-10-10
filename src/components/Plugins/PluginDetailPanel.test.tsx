/**
 * Tests for the plugin detail panel (#1997): identity/extension-points/permissions
 * rendering, state-appropriate actions (Enable/Disable/Retry, Settings…), the
 * error callout, and action dispatch to the store. Uninstall opens a confirm
 * dialog that warns about active sessions before dispatching.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import React from "react";
import { useAppStore } from "@/store/appStore";
import type { InstalledPlugin, PluginManifest, PluginState } from "@/types/plugin";
import { withTooltip } from "@/test/tooltip";
import { PluginDetailPanel } from "./PluginDetailPanel";
import { usePluginUpdateStore } from "@/plugins/pluginUpdateStore";

const hostPlatform = vi.hoisted(() => ({ value: "aarch64-apple-darwin" as string | null }));
vi.mock("@/hooks/usePluginHostPlatform", () => ({
  usePluginHostPlatform: () => hostPlatform.value,
}));

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "k8s",
    name: "Kubernetes Exec",
    version: "1.2.0",
    author: "k8s-contrib",
    description: "Terminal backend for Kubernetes pod exec sessions.",
    license: "MIT",
    apiVersion: "1.0",
    platforms: ["macos"],
    permissions: ["terminal", "network"],
    extensions: {
      terminalBackend: {
        connectionType: "k8s-exec",
        displayName: "Kubernetes Exec",
        configSchema: {},
      },
    },
    ...overrides,
  };
}

function plugin(state: PluginState, m: Partial<PluginManifest> = {}): InstalledPlugin {
  return {
    manifest: manifest(m),
    state,
    errorMessage: state === "error" ? "dependency aws CLI not found in PATH" : undefined,
    installedAt: 1767225600000,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(pluginId = "k8s") {
  act(() =>
    root.render(
      withTooltip(React.createElement(PluginDetailPanel, { meta: { pluginId }, isVisible: true }))
    )
  );
}

describe("PluginDetailPanel (#1997)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    hostPlatform.value = "aarch64-apple-darwin";
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the Updates block only for a plugin that publishes an updateUrl (PROD-051)", () => {
    useAppStore.setState({ plugins: [plugin("active")] });
    render();
    expect(container.querySelector('[data-testid="plugin-update"]')).toBeNull();

    act(() => {
      useAppStore.setState({
        plugins: [plugin("active", { updateUrl: "https://example.com/k8s/update.json" })],
      });
    });
    render();
    expect(container.querySelector('[data-testid="plugin-update"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-update-check"]')).not.toBeNull();
  });

  it("shows the Updates block for a plugin the plugin index offers an update for (#3717)", () => {
    useAppStore.setState({ plugins: [plugin("active")] });
    usePluginUpdateStore.setState({
      indexOffers: {
        k8s: {
          entry: {
            id: "k8s",
            name: "Kubernetes Exec",
            description: "d",
            author: "a",
            version: "1.3.0",
            minHostAbi: "1.0",
            native: false,
            packages: [{ platforms: ["any"], url: "https://e/k.zip", sha256: "0".repeat(64) }],
          },
          abiCompatible: true,
          hostAbi: "1.1",
          platformSupported: true,
          hostPlatform: "aarch64-apple-darwin",
          toolchain: "notApplicable",
          installedVersion: "1.2.0",
          installStatus: "updateAvailable",
          installable: true,
        },
      },
    });
    render();
    expect(container.querySelector('[data-testid="plugin-update-index-available"]')).not.toBeNull();
    act(() => {
      usePluginUpdateStore.setState({ indexOffers: {} });
    });
  });

  it("renders identity, extension points, and permissions", () => {
    useAppStore.setState({ plugins: [plugin("active")] });
    render();

    expect(container.querySelector('[data-testid="plugin-detail"]')?.textContent).toContain(
      "Kubernetes Exec"
    );
    expect(container.querySelector('[data-testid="plugin-detail-status"]')?.textContent).toContain(
      "Enabled"
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Terminal Backend");
    expect(text).toContain("k8s-exec");
    expect(text).toContain("Terminal");
    expect(text).toContain("create and manage terminal sessions");
  });

  it("shows Disable for an enabled plugin and dispatches it", async () => {
    const disablePlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ plugins: [plugin("active")], disablePlugin });
    render();

    const btn = container.querySelector('[data-testid="plugin-action-disable"]');
    expect(btn).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-action-enable"]')).toBeNull();
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(disablePlugin).toHaveBeenCalledWith("k8s");
  });

  it("shows Enable for a disabled plugin and dispatches it", async () => {
    const enablePlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ plugins: [plugin("disabled")], enablePlugin });
    render();

    const btn = container.querySelector('[data-testid="plugin-action-enable"]');
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(enablePlugin).toHaveBeenCalledWith("k8s");
  });

  it("shows Retry and the error callout for a failed plugin", async () => {
    const enablePlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ plugins: [plugin("error")], enablePlugin });
    render();

    expect(container.querySelector('[data-testid="plugin-detail-error"]')?.textContent).toContain(
      "dependency aws CLI not found"
    );
    // A load failure keeps its full layout (#4578): meta line, extension
    // points, and no invalid-manifest hint.
    expect(container.querySelector(".plugin-detail__meta")?.textContent).toContain(
      "v1.2.0 · by k8s-contrib"
    );
    expect(
      container.querySelector('[data-testid="plugin-detail-extension-points"]')
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-detail-invalid-hint"]')).toBeNull();
    const btn = container.querySelector('[data-testid="plugin-action-retry"]');
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(enablePlugin).toHaveBeenCalledWith("k8s");
  });

  it("shows the Settings… action only when settings are declared", () => {
    useAppStore.setState({ plugins: [plugin("active")] });
    render();
    expect(container.querySelector('[data-testid="plugin-action-settings"]')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    useAppStore.setState({
      plugins: [
        plugin("active", { settings: { ns: { type: "string", default: "", description: "" } } }),
      ],
    });
    render();
    expect(container.querySelector('[data-testid="plugin-action-settings"]')).not.toBeNull();
  });

  it("deep-links the Settings… action into the Plugins settings category for this plugin", async () => {
    const openSettingsTab = vi.fn();
    useAppStore.setState({
      plugins: [
        plugin("active", { settings: { ns: { type: "string", default: "", description: "" } } }),
      ],
      openSettingsTab,
    });
    render();

    const btn = container.querySelector('[data-testid="plugin-action-settings"]');
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(openSettingsTab).toHaveBeenCalledWith({ category: "plugins", pluginId: "k8s" });
  });

  it("renders a placeholder when the plugin is no longer installed", () => {
    useAppStore.setState({ plugins: [] });
    render("gone");
    expect(container.querySelector('[data-testid="plugin-detail-missing"]')).not.toBeNull();
  });

  it("confirms before uninstalling and dispatches on confirm", async () => {
    const uninstallPlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ plugins: [plugin("active")], uninstallPlugin });
    render();

    act(() =>
      container
        .querySelector('[data-testid="plugin-action-uninstall"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    const confirm = document.querySelector('[data-testid="plugin-uninstall-confirm"]');
    expect(confirm).not.toBeNull();
    expect(uninstallPlugin).not.toHaveBeenCalled();

    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(uninstallPlugin).toHaveBeenCalledWith("k8s");
  });

  it("shows the reason and Uninstall for a plugin whose manifest no longer validates (#4392)", async () => {
    // The backend lists such a plugin as `error` under a placeholder manifest:
    // id + leniently-read name/version/author, nothing capability-bearing.
    const uninstallPlugin = vi.fn(() => Promise.resolve());
    const reason = "plugin manifest `filesystemPaths` entry `/` is the filesystem root";
    useAppStore.setState({
      plugins: [
        {
          manifest: {
            id: "old-plugin",
            name: "Old Plugin",
            version: "1.2.3",
            author: "",
            description: "",
            license: "",
            apiVersion: "",
            platforms: [],
            permissions: [],
            extensions: {},
          },
          state: "error",
          errorMessage: reason,
          invalidManifest: true,
          installedAt: 1767225600000,
        },
      ],
      uninstallPlugin,
    });
    render("old-plugin");

    expect(container.querySelector('[data-testid="plugin-detail"]')?.textContent).toContain(
      "Old Plugin"
    );
    // #4578: no Retry (enable can only fail again), no Enable/Disable, no empty
    // Extension Points block, and the meta line omits the absent author.
    expect(container.querySelector('[data-testid="plugin-action-retry"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugin-action-enable"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugin-action-disable"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugin-detail-extension-points"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugin-detail-meta"]')?.textContent).toBe(
      "v1.2.3"
    );
    expect(container.querySelector('[data-testid="plugin-detail-invalid-hint"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-detail-error"]')?.textContent).toContain(
      reason
    );
    act(() =>
      container
        .querySelector('[data-testid="plugin-action-uninstall"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await act(async () => {
      document
        .querySelector('[data-testid="plugin-uninstall-confirm"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(uninstallPlugin).toHaveBeenCalledWith("old-plugin");
  });

  it("omits the meta line entirely for an invalid manifest with no readable version or author (#4578)", () => {
    useAppStore.setState({
      plugins: [
        {
          manifest: {
            id: "old-plugin",
            name: "old-plugin",
            version: "",
            author: "",
            description: "",
            license: "",
            apiVersion: "",
            platforms: [],
            permissions: [],
            extensions: {},
          },
          state: "error",
          errorMessage: "manifest is not valid JSON",
          invalidManifest: true,
          installedAt: 1767225600000,
        },
      ],
    });
    render("old-plugin");

    expect(container.querySelector(".plugin-detail__meta")).toBeNull();
    expect(container.textContent).not.toContain(" · by ");
    expect(container.querySelector('[data-testid="plugin-action-retry"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugin-action-uninstall"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-detail-error"]')?.textContent).toContain(
      "manifest is not valid JSON"
    );
  });

  describe("supported platforms (#3507)", () => {
    const backend = (libraries?: Record<string, string>) => ({
      extensions: {
        terminalBackend: {
          connectionType: "k8s-exec",
          displayName: "Kubernetes Exec",
          configSchema: {},
          ...(libraries ? { libraries } : {}),
        },
      },
    });
    const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

    it("lists a multi-platform plugin's platforms and marks this computer", () => {
      useAppStore.setState({
        plugins: [
          plugin(
            "active",
            backend({
              "aarch64-apple-darwin": "backend/aarch64-apple-darwin/libk8s.dylib",
              "aarch64-pc-windows-msvc": "backend/aarch64-pc-windows-msvc/k8s.dll",
              "aarch64-unknown-linux-gnu": "backend/aarch64-unknown-linux-gnu/libk8s.so",
            })
          ),
        ],
      });
      render();
      const mac = q("plugin-detail-platform-aarch64-apple-darwin")!;
      expect(mac.textContent).toContain("macOS (Apple Silicon)");
      expect(mac.textContent).toContain("This computer");
      expect(q("plugin-detail-platform-aarch64-pc-windows-msvc")?.textContent).toContain(
        "Windows ARM64"
      );
      expect(q("plugin-detail-platform-aarch64-unknown-linux-gnu")?.textContent).toContain(
        "Linux ARM64"
      );
      expect(
        container.querySelectorAll('[data-testid="plugin-detail-platform-current"]')
      ).toHaveLength(1);
    });

    it("marks nothing while this computer's platform is unknown", () => {
      hostPlatform.value = null;
      useAppStore.setState({
        plugins: [plugin("active", backend({ "x86_64-apple-darwin": "backend/x/libk8s.dylib" }))],
      });
      render();
      expect(q("plugin-detail-platform-x86_64-apple-darwin")?.textContent).toContain(
        "macOS (Intel)"
      );
      expect(q("plugin-detail-platform-current")).toBeNull();
    });

    it("labels a legacy single-platform native plugin", () => {
      useAppStore.setState({ plugins: [plugin("active", backend())] });
      render();
      expect(q("plugin-detail-platforms-legacy")?.textContent).toBe(
        "Current platform only (legacy package)"
      );
    });

    it("shows no platform section for a plugin without native code", () => {
      useAppStore.setState({
        plugins: [
          plugin("active", {
            permissions: [],
            extensions: { theme: { themes: [{ id: "t", name: "T", file: "t.json" }] } },
          }),
        ],
      });
      render();
      expect(q("plugin-detail-platforms")).toBeNull();
      expect(container.textContent).not.toContain("Supported Platforms");
    });
  });
});
