/**
 * Tests for the Plugins sidebar view (#1997): the installed list rendering,
 * per-plugin state dots, search filtering, row selection dispatch, and the
 * install-from-file → validate → dialog flow. The store is driven directly
 * (real slice, overridden actions) and the Tauri file picker + validate command
 * are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import React from "react";
import { useAppStore } from "@/store/appStore";
import type { InstalledPlugin, PluginState } from "@/types/plugin";
import { withTooltip } from "@/test/tooltip";
import { usePluginUpdateStore } from "@/plugins/pluginUpdateStore";
import { PluginManagerView } from "./PluginManagerView";

const openMock = vi.fn();
const validateMock = vi.fn();
const assessTrustMock = vi.fn();
const checkUpdatesMock = vi.fn();
const fetchIndexMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openMock(...a) }));
vi.mock("@/services/api", () => ({
  previewPlugin: (...a: unknown[]) => validateMock(...a),
  assessPluginTrust: (...a: unknown[]) => assessTrustMock(...a),
  checkPluginUpdates: (...a: unknown[]) => checkUpdatesMock(...a),
  fetchPluginIndex: (...a: unknown[]) => fetchIndexMock(...a),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

function plugin(id: string, name: string, version: string, state: PluginState): InstalledPlugin {
  return {
    manifest: {
      id,
      name,
      version,
      author: "author",
      description: "desc",
      license: "MIT",
      apiVersion: "1.0",
      platforms: ["macos"],
      permissions: ["terminal", "network"],
      extensions: {
        terminalBackend: { connectionType: id, displayName: name, configSchema: {} },
      },
    },
    state,
    errorMessage: state === "error" ? "boom" : undefined,
    installedAt: "2026-01-01T00:00:00Z",
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function render() {
  act(() => root.render(withTooltip(React.createElement(PluginManagerView))));
}

describe("PluginManagerView (#1997)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    usePluginUpdateStore.setState({
      entries: {},
      checkingAll: false,
      lastCheckedAt: null,
      indexOffers: {},
      checkingIndex: false,
      indexError: null,
    });
    checkUpdatesMock.mockReset();
    fetchIndexMock.mockReset();
    fetchIndexMock.mockResolvedValue({ url: "https://idx", isDefault: true, entries: [] });
    openMock.mockReset();
    validateMock.mockReset();
    assessTrustMock.mockReset();
    // Default: an unsigned (untrusted) package, so the dialog opens normally.
    assessTrustMock.mockResolvedValue({
      level: "untrusted",
      warning: "Untrusted source.",
      keyId: null,
      publisher: null,
      publicKey: null,
      requiresAcceptance: true,
      isBlocked: false,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders each installed plugin with its state dot and version", () => {
    useAppStore.setState({
      plugins: [
        plugin("k8s", "Kubernetes Exec", "1.2.0", "active"),
        plugin("logcol", "Log Colorizer", "0.3.0", "disabled"),
        plugin("aws", "AWS CloudShell", "0.9.0", "error"),
      ],
    });
    render();

    expect(container.querySelector('[data-testid="plugin-row-k8s"]')).not.toBeNull();
    // The dot renders via the shared StatusDot primitive: enabled → connected,
    // disabled → disabled, error → disconnected tone (UISF-003 follow-up).
    expect(container.querySelector('[data-testid="plugin-state-dot-k8s"]')?.className).toContain(
      "status-dot--connected"
    );
    expect(container.querySelector('[data-testid="plugin-state-dot-logcol"]')?.className).toContain(
      "status-dot--disabled"
    );
    expect(container.querySelector('[data-testid="plugin-state-dot-aws"]')?.className).toContain(
      "status-dot--disconnected"
    );
    expect(container.querySelector('[data-testid="plugin-row-k8s"]')?.textContent).toContain(
      "v1.2.0"
    );
    // Installed count header reflects total.
    expect(container.querySelector(".plugin-manager__sep")?.textContent).toBe("Installed (3)");
  });

  it("shows an empty state when nothing is installed", () => {
    render();
    expect(container.querySelector('[data-testid="plugin-list-empty"]')?.textContent).toBe(
      "No plugins installed"
    );
  });

  it("filters the list by the search query", async () => {
    useAppStore.setState({
      plugins: [
        plugin("k8s", "Kubernetes Exec", "1.2.0", "active"),
        plugin("logcol", "Log Colorizer", "0.3.0", "disabled"),
      ],
    });
    render();

    const search = container.querySelector<HTMLInputElement>('[data-testid="plugin-search"]')!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(search, "color");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="plugin-row-logcol"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-row-k8s"]')).toBeNull();
    // Header still shows the full installed count, not the filtered count.
    expect(container.querySelector(".plugin-manager__sep")?.textContent).toBe("Installed (2)");
  });

  it("clears the query and restores the full list via the SearchInput clear button", () => {
    useAppStore.setState({
      plugins: [
        plugin("k8s", "Kubernetes Exec", "1.2.0", "active"),
        plugin("logcol", "Log Colorizer", "0.3.0", "disabled"),
      ],
    });
    render();

    const search = container.querySelector<HTMLInputElement>('[data-testid="plugin-search"]')!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(search, "color");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Only the matching row is shown, and the clear button is now present.
    expect(container.querySelector('[data-testid="plugin-row-k8s"]')).toBeNull();
    const clear = container.querySelector<HTMLButtonElement>(".ui-search-input__clear")!;
    expect(clear).not.toBeNull();

    act(() => clear.click());

    // Clearing restores the full list.
    expect(container.querySelector('[data-testid="plugin-row-k8s"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-row-logcol"]')).not.toBeNull();
    expect(container.querySelector(".ui-search-input__clear")).toBeNull();
  });

  it("dispatches selectPlugin when a row is clicked", () => {
    const selectPlugin = vi.fn();
    useAppStore.setState({
      plugins: [plugin("k8s", "Kubernetes Exec", "1.2.0", "active")],
      selectPlugin,
    });
    render();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="plugin-row-k8s"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(selectPlugin).toHaveBeenCalledWith("k8s");
  });

  it("validates a picked package and opens the install dialog", async () => {
    openMock.mockResolvedValue("/tmp/k8s-exec-1.2.0.termihub-plugin");
    validateMock.mockResolvedValue({
      manifest: plugin("k8s", "Kubernetes Exec", "1.2.0", "installed").manifest,
      hostPlatform: "aarch64-apple-darwin",
      platformSupported: true,
    });
    render();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="plugin-install-from-file"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(validateMock).toHaveBeenCalledWith("/tmp/k8s-exec-1.2.0.termihub-plugin");
    expect(document.querySelector('[data-testid="plugin-install-dialog"]')).not.toBeNull();
  });

  it("opens the dialog with a not-available explanation for another platform's package", async () => {
    openMock.mockResolvedValue("/tmp/k8s-exec-1.2.0.termihub-plugin");
    const manifest = plugin("k8s", "Kubernetes Exec", "1.2.0", "installed").manifest;
    manifest.extensions.terminalBackend!.libraries = {
      "x86_64-unknown-linux-gnu": "backend/x86_64-unknown-linux-gnu/libk8s.so",
    };
    validateMock.mockResolvedValue({
      manifest,
      hostPlatform: "aarch64-apple-darwin",
      platformSupported: false,
    });
    render();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="plugin-install-from-file"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const unavailable = document.querySelector(
      '[data-testid="plugin-install-platform-unavailable"]'
    );
    expect(unavailable?.textContent).toContain("macOS (Apple Silicon)");
    expect(
      document.querySelector('[data-testid="plugin-install-platform-x86_64-unknown-linux-gnu"]')
        ?.textContent
    ).toContain("Linux x64");
    expect(document.querySelector('[data-testid="plugin-install-confirm"]')).toBeNull();
  });

  it("does nothing when the file picker is cancelled", async () => {
    openMock.mockResolvedValue(null);
    render();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="plugin-install-from-file"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(validateMock).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="plugin-install-dialog"]')).toBeNull();
  });

  describe("update check (PROD-051)", () => {
    function updatable(id: string, version: string): InstalledPlugin {
      const p = plugin(id, id, version, "active");
      p.manifest.updateUrl = `https://example.com/${id}/update.json`;
      return p;
    }

    it("hides the check button when no plugin is installed", () => {
      useAppStore.setState({ plugins: [] });
      render();
      expect(container.querySelector('[data-testid="plugin-check-updates"]')).toBeNull();
    });

    it("badges a plugin without an updateUrl that the plugin index offers an update for", async () => {
      useAppStore.setState({ plugins: [plugin("k8s", "Kubernetes Exec", "1.2.0", "active")] });
      checkUpdatesMock.mockResolvedValue([]);
      fetchIndexMock.mockResolvedValue({
        url: "https://idx",
        isDefault: true,
        entries: [
          {
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
        ],
      });
      render();
      expect(container.querySelector('[data-testid="plugin-update-badge-k8s"]')).toBeNull();

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="plugin-check-updates"]')!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();

      expect(fetchIndexMock).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="plugin-update-badge-k8s"]')).not.toBeNull();
    });

    it("checks every plugin and badges the ones with an update", async () => {
      useAppStore.setState({ plugins: [updatable("a", "1.0.0"), updatable("b", "2.0.0")] });
      checkUpdatesMock.mockResolvedValue([
        {
          pluginId: "a",
          outcome: {
            pluginId: "a",
            installedVersion: "1.0.0",
            latestVersion: "1.1.0",
            status: "updateAvailable",
            downloadUrl: "https://example.com/a.termihub-plugin",
            sha256: "0".repeat(64),
            minHostAbi: "1.0",
          },
        },
        {
          pluginId: "b",
          outcome: {
            pluginId: "b",
            installedVersion: "2.0.0",
            latestVersion: "2.0.0",
            status: "upToDate",
            downloadUrl: "https://example.com/b.termihub-plugin",
            sha256: "0".repeat(64),
            minHostAbi: "1.0",
          },
        },
      ]);
      render();
      expect(container.querySelector('[data-testid="plugin-update-badge-a"]')).toBeNull();

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="plugin-check-updates"]')!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();

      expect(checkUpdatesMock).toHaveBeenCalledWith(undefined);
      expect(container.querySelector('[data-testid="plugin-update-badge-a"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="plugin-update-badge-b"]')).toBeNull();
    });
  });
});
