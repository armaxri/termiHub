/**
 * Tests for the plugin detail panel's update block (PROD-051): each check state
 * renders its message, "Check for updates" checks only this plugin, and
 * "Download & install…" downloads + validates the package and hands it to the
 * normal install dialog (never installing it directly).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import React from "react";
import type { InstalledPlugin, PluginUpdateCheckOutcome } from "@/types/plugin";
import { usePluginUpdateStore, type PluginUpdateEntry } from "@/plugins/pluginUpdateStore";
import { withTooltip } from "@/test/tooltip";

const { toastMock } = vi.hoisted(() => ({
  toastMock: {
    loading: vi.fn(() => "t1"),
    dismiss: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));
const checkMock = vi.fn();
const downloadMock = vi.fn();
const validateMock = vi.fn();
const assessTrustMock = vi.fn();
const openUrlMock = vi.fn();

vi.mock("@/services/api", () => ({
  checkPluginUpdates: (...a: unknown[]) => checkMock(...a),
  downloadPluginUpdate: (...a: unknown[]) => downloadMock(...a),
  validatePlugin: (...a: unknown[]) => validateMock(...a),
  assessPluginTrust: (...a: unknown[]) => assessTrustMock(...a),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...a: unknown[]) => openUrlMock(...a) }));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("@/components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui")>()),
  toast: toastMock,
}));
vi.mock("./PluginInstallDialog", () => ({
  PluginInstallDialog: (props: { filePath: string; manifest: { version: string } }) =>
    React.createElement(
      "div",
      { "data-testid": "install-dialog" },
      `${props.filePath}|${props.manifest.version}`
    ),
}));

import { PluginUpdateSection } from "./PluginUpdateSection";

const PLUGIN: InstalledPlugin = {
  manifest: {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    author: "a",
    description: "d",
    license: "MIT",
    apiVersion: "1.0",
    platforms: ["linux"],
    permissions: [],
    extensions: { theme: { themes: [] } },
    updateUrl: "https://example.com/demo/update.json",
  },
  state: "active",
  installedAt: "2026-01-01T00:00:00Z",
} as InstalledPlugin;

function outcome(
  status: PluginUpdateCheckOutcome["status"],
  latestVersion = "1.1.0"
): PluginUpdateCheckOutcome {
  return {
    pluginId: "demo",
    installedVersion: "1.0.0",
    latestVersion,
    status,
    downloadUrl: "https://example.com/demo-1.1.0.termihub-plugin",
    sha256: "0".repeat(64),
    minHostAbi: status === "incompatibleHost" ? "1.3" : "1.0",
    changelogUrl: "https://example.com/demo/CHANGELOG",
  };
}

let container: HTMLDivElement;
let root: Root;

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function render(entry?: PluginUpdateEntry) {
  usePluginUpdateStore.setState({
    entries: entry ? { demo: entry } : {},
    checkingAll: false,
    lastCheckedAt: null,
  });
  act(() => root.render(withTooltip(React.createElement(PluginUpdateSection, { plugin: PLUGIN }))));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PluginUpdateSection (PROD-051)", () => {
  it("explains the opt-in model before any check and offers no download", () => {
    render();
    expect(q("plugin-update-idle")?.textContent).toContain(
      "never installs without your confirmation"
    );
    expect(q("plugin-update-download")).toBeNull();
  });

  it("checks only this plugin", async () => {
    checkMock.mockResolvedValue([{ pluginId: "demo", outcome: outcome("upToDate", "1.0.0") }]);
    render();
    await act(async () => q("plugin-update-check")?.click());
    await flush();
    expect(checkMock).toHaveBeenCalledWith("demo");
    expect(q("plugin-update-uptodate")?.textContent).toContain("v1.0.0");
  });

  it("renders the checking, error and incompatible states", () => {
    render({ phase: "checking" });
    expect(q("plugin-update-checking")).not.toBeNull();
    expect(q("plugin-update-check")?.hasAttribute("disabled")).toBe(true);

    render({ phase: "error", error: "update document field `sha256` is invalid" });
    expect(q("plugin-update-error")?.textContent).toContain("sha256");

    render({ phase: "checked", outcome: outcome("incompatibleHost") });
    expect(q("plugin-update-incompatible")?.textContent).toContain("plugin ABI 1.3");
    expect(q("plugin-update-download")).toBeNull();
    expect(q("plugin-update-changelog")).not.toBeNull();
  });

  it("offers download and changelog when an update is available", async () => {
    render({ phase: "checked", outcome: outcome("updateAvailable") });
    expect(q("plugin-update-available")?.textContent).toContain("v1.0.0 → v1.1.0");
    await act(async () => q("plugin-update-changelog")?.click());
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/demo/CHANGELOG");
  });

  it("hands the downloaded, validated package to the install dialog", async () => {
    downloadMock.mockResolvedValue("/cache/plugin-updates/demo-1.1.0.termihub-plugin");
    validateMock.mockResolvedValue({ ...PLUGIN.manifest, version: "1.1.0" });
    assessTrustMock.mockResolvedValue({ level: "untrusted", requiresAcceptance: true });
    render({ phase: "checked", outcome: outcome("updateAvailable") });

    await act(async () => q("plugin-update-download")?.click());
    await flush();

    expect(downloadMock).toHaveBeenCalledWith("demo");
    expect(validateMock).toHaveBeenCalledWith("/cache/plugin-updates/demo-1.1.0.termihub-plugin");
    expect(assessTrustMock).toHaveBeenCalled();
    expect(q("install-dialog")?.textContent).toBe(
      "/cache/plugin-updates/demo-1.1.0.termihub-plugin|1.1.0"
    );
  });

  it("reports a failed download without opening the install dialog", async () => {
    downloadMock.mockRejectedValue("downloaded package does not match the published SHA-256");
    render({ phase: "checked", outcome: outcome("updateAvailable") });

    await act(async () => q("plugin-update-download")?.click());
    await flush();

    expect(q("install-dialog")).toBeNull();
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("SHA-256"),
      expect.objectContaining({ id: "t1" })
    );
  });
});
