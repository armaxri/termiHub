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
import { PluginManagerView } from "./PluginManagerView";

const openMock = vi.fn();
const validateMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openMock(...a) }));
vi.mock("@/services/api", () => ({ validatePlugin: (...a: unknown[]) => validateMock(...a) }));
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
    openMock.mockReset();
    validateMock.mockReset();
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
    expect(container.querySelector('[data-testid="plugin-state-dot-k8s"]')?.className).toContain(
      "plugin-state-dot--enabled"
    );
    expect(container.querySelector('[data-testid="plugin-state-dot-logcol"]')?.className).toContain(
      "plugin-state-dot--disabled"
    );
    expect(container.querySelector('[data-testid="plugin-state-dot-aws"]')?.className).toContain(
      "plugin-state-dot--error"
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
    validateMock.mockResolvedValue(plugin("k8s", "Kubernetes Exec", "1.2.0", "installed").manifest);
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
});
