/**
 * PluginCatalogSettings (PROD-048): Settings → Plugins → Browse Plugins. Pins
 * that the index is fetched only on request, entries show their compatibility
 * (ABI / platform / toolchain / native) and install state, search filters, and
 * Install / Install-from-URL download a verified package and hand it to the
 * normal install dialog (never installing directly).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import type { AppSettings } from "@/types/connection";
import type { InstalledPlugin, PluginIndexEntryView, PluginIndexResult } from "@/types/plugin";
import { withTooltip } from "@/test/tooltip";

const { toastMock } = vi.hoisted(() => ({
  toastMock: {
    loading: vi.fn(() => "t1"),
    dismiss: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));
const fetchIndexMock = vi.fn();
const downloadIndexMock = vi.fn();
const downloadUrlMock = vi.fn();
const previewMock = vi.fn();
const assessTrustMock = vi.fn();
const updateSettings = vi.fn(() => Promise.resolve());
let mockSettings: AppSettings;
let mockPlugins: InstalledPlugin[];

vi.mock("@/services/api", () => ({
  fetchPluginIndex: (...a: unknown[]) => fetchIndexMock(...a),
  downloadPluginFromIndex: (...a: unknown[]) => downloadIndexMock(...a),
  downloadPluginFromUrl: (...a: unknown[]) => downloadUrlMock(...a),
  previewPlugin: (...a: unknown[]) => previewMock(...a),
  assessPluginTrust: (...a: unknown[]) => assessTrustMock(...a),
}));
vi.mock("@/store/useProjectedSettings", () => ({
  useProjectedSettings: (): AppSettings => mockSettings,
}));
interface FakeStoreState {
  updateSettings: (settings: AppSettings) => Promise<void>;
  plugins: InstalledPlugin[];
}
vi.mock("@/store/appStore", () => ({
  useAppStore: <T,>(selector: (s: FakeStoreState) => T): T =>
    selector({ updateSettings, plugins: mockPlugins }),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("@/components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui")>()),
  toast: toastMock,
}));
vi.mock("@/components/Plugins/PluginInstallDialog", () => ({
  PluginInstallDialog: (props: { filePath: string; manifest: { id: string } }) =>
    React.createElement(
      "div",
      { "data-testid": "install-dialog" },
      `${props.filePath}|${props.manifest.id}`
    ),
}));

import { PluginCatalogSettings, entryMatches } from "./PluginCatalogSettings";
import { usePluginUpdateStore } from "@/plugins/pluginUpdateStore";
import { shaFieldError, urlFieldError } from "./PluginUrlInstall";

const SHA = "ab".repeat(32);

function view(
  id: string,
  overrides: Partial<PluginIndexEntryView> = {},
  entry: Partial<PluginIndexEntryView["entry"]> = {}
): PluginIndexEntryView {
  return {
    entry: {
      id,
      name: `Plugin ${id}`,
      description: `Does ${id} things`,
      author: "Jane",
      version: "1.2.0",
      minHostAbi: "1.0",
      native: false,
      packages: [{ platforms: ["any"], url: `https://e.com/${id}`, sha256: SHA }],
      ...entry,
    },
    abiCompatible: true,
    hostAbi: "1.1",
    platformSupported: true,
    hostPlatform: "aarch64-apple-darwin",
    toolchain: "notApplicable",
    installStatus: "notInstalled",
    installable: true,
    ...overrides,
  };
}

function result(entries: PluginIndexEntryView[]): PluginIndexResult {
  return { url: "https://e.com/index.json", isDefault: true, entries };
}

let container: HTMLDivElement;
let root: Root;

function q(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render() {
  act(() => root.render(withTooltip(<PluginCatalogSettings />)));
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function click(testId: string) {
  await act(async () => {
    q(testId)!.click();
  });
  await flush();
}

function type(testId: string, value: string) {
  const input = q(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PluginCatalogSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockSettings = { version: "1", externalConnectionFiles: [] } as unknown as AppSettings;
    mockPlugins = [];
    vi.clearAllMocks();
    previewMock.mockResolvedValue({
      manifest: { id: "alpha", version: "1.2.0" },
      hostPlatform: "aarch64-apple-darwin",
      platformSupported: true,
    });
    assessTrustMock.mockResolvedValue({ level: "untrusted", isBlocked: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not fetch the index until the user asks", async () => {
    render();
    await flush();
    expect(fetchIndexMock).not.toHaveBeenCalled();
    expect(q("plugin-catalog-list")).toBeNull();
    expect(container.textContent).toContain("only fetched when you");
  });

  it("lists entries with compatibility badges and filters by search", async () => {
    fetchIndexMock.mockResolvedValue(
      result([
        view("alpha"),
        view(
          "beta",
          {
            abiCompatible: false,
            installable: false,
            toolchain: "mismatch",
            blockedReason: "Needs plugin ABI 2.0; update termiHub first.",
          },
          {
            native: true,
            minHostAbi: "2.0",
            toolchain: { rustc: "1.90.0 (abc)", panicStrategy: "unwind" },
          }
        ),
      ])
    );
    render();
    await click("plugin-catalog-load");

    expect(q("plugin-catalog-entry-alpha")).not.toBeNull();
    expect(q("plugin-catalog-abi-alpha")!.dataset.tone).toBe("ok");
    expect(q("plugin-catalog-platform-alpha")!.textContent).toContain("This computer");
    expect(q("plugin-catalog-toolchain-alpha")).toBeNull();
    expect(q("plugin-catalog-native-alpha")).toBeNull();
    expect((q("plugin-catalog-install-alpha") as HTMLButtonElement).disabled).toBe(false);

    expect(q("plugin-catalog-abi-beta")!.dataset.tone).toBe("bad");
    expect(q("plugin-catalog-toolchain-beta")!.textContent).toContain("Toolchain mismatch");
    expect(q("plugin-catalog-native-beta")).not.toBeNull();
    expect((q("plugin-catalog-install-beta") as HTMLButtonElement).disabled).toBe(true);
    expect(q("plugin-catalog-blocked-beta")!.textContent).toContain("ABI 2.0");

    type("plugin-catalog-search", "beta things");
    expect(q("plugin-catalog-entry-alpha")).toBeNull();
    expect(q("plugin-catalog-entry-beta")).not.toBeNull();
    type("plugin-catalog-search", "zzz");
    expect(q("plugin-catalog-empty")!.textContent).toContain("No plugins match");
  });

  it("shows an empty index and a load error clearly", async () => {
    fetchIndexMock.mockResolvedValueOnce(result([]));
    render();
    await click("plugin-catalog-load");
    expect(q("plugin-catalog-empty")!.textContent).toContain("lists no plugins yet");

    fetchIndexMock.mockRejectedValueOnce("could not fetch the plugin index: HTTP 404");
    await click("plugin-catalog-load");
    expect(q("plugin-catalog-error")!.textContent).toContain("HTTP 404");
  });

  it("shows update and installed states against the live plugin list", async () => {
    mockPlugins = [
      { manifest: { id: "alpha", version: "1.0.0" } } as InstalledPlugin,
      { manifest: { id: "gamma", version: "1.2.0" } } as InstalledPlugin,
    ];
    fetchIndexMock.mockResolvedValue(
      result([
        view("alpha", { installStatus: "updateAvailable", installedVersion: "1.0.0" }),
        view("gamma", {
          installStatus: "installed",
          installedVersion: "1.2.0",
          installable: false,
          blockedReason: "This version is installed.",
        }),
      ])
    );
    render();
    await click("plugin-catalog-load");
    expect(q("plugin-catalog-status-alpha")!.textContent).toContain("v1.0.0 → v1.2.0");
    expect(q("plugin-catalog-install-alpha")!.textContent).toContain("Update");
    expect(q("plugin-catalog-status-gamma")!.textContent).toBe("Installed");
    expect((q("plugin-catalog-install-gamma") as HTMLButtonElement).disabled).toBe(true);
    expect(q("plugin-catalog-blocked-gamma")).toBeNull();
  });

  it("shares a loaded index's update offers with the Plugins view (#3717)", async () => {
    usePluginUpdateStore.setState({ indexOffers: {}, indexError: null });
    fetchIndexMock.mockResolvedValue(
      result([
        view("alpha", { installStatus: "updateAvailable", installedVersion: "1.0.0" }),
        view("beta"),
      ])
    );
    render();
    await click("plugin-catalog-load");
    expect(Object.keys(usePluginUpdateStore.getState().indexOffers)).toEqual(["alpha"]);
  });

  it("downloads a listed plugin and opens the normal install dialog", async () => {
    fetchIndexMock.mockResolvedValue(result([view("alpha")]));
    downloadIndexMock.mockResolvedValue("/cache/plugin-downloads/alpha-1.2.0.termihub-plugin");
    render();
    await click("plugin-catalog-load");
    await click("plugin-catalog-install-alpha");

    expect(downloadIndexMock).toHaveBeenCalledWith("alpha");
    expect(previewMock).toHaveBeenCalledWith("/cache/plugin-downloads/alpha-1.2.0.termihub-plugin");
    expect(assessTrustMock).toHaveBeenCalled();
    expect(q("install-dialog")!.textContent).toBe(
      "/cache/plugin-downloads/alpha-1.2.0.termihub-plugin|alpha"
    );
  });

  it("reports a failed (e.g. checksum-mismatch) download without opening the dialog", async () => {
    fetchIndexMock.mockResolvedValue(result([view("alpha")]));
    downloadIndexMock.mockRejectedValue("does not match the expected SHA-256");
    render();
    await click("plugin-catalog-load");
    await click("plugin-catalog-install-alpha");
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("SHA-256"),
      expect.anything()
    );
    expect(q("install-dialog")).toBeNull();
  });

  it("persists a custom https index URL and refuses plain http", () => {
    render();
    type("plugin-catalog-url", "http://evil.example/index.json");
    act(() =>
      q("plugin-catalog-url")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    );
    expect(updateSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Only https:// URLs are allowed.");
    expect((q("plugin-catalog-load") as HTMLButtonElement).disabled).toBe(true);

    type("plugin-catalog-url", "https://corp.example/index.json");
    act(() =>
      q("plugin-catalog-url")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    );
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ pluginIndexUrl: "https://corp.example/index.json" })
    );
  });

  it("offers to reset a custom index URL to the default", async () => {
    mockSettings = { ...mockSettings, pluginIndexUrl: "https://corp.example/index.json" };
    render();
    await click("plugin-catalog-url-reset");
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ pluginIndexUrl: undefined })
    );
  });

  it("installs from a pasted URL only with an https URL and a valid checksum", async () => {
    downloadUrlMock.mockResolvedValue("/cache/plugin-downloads/url-x.termihub-plugin");
    render();
    const button = () => q("plugin-url-install-download") as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    type("plugin-url-install-url", "https://e.com/p.termihub-plugin");
    type("plugin-url-install-sha", "nope");
    expect(button().disabled).toBe(true);
    type("plugin-url-install-sha", SHA);
    expect(button().disabled).toBe(false);
    await click("plugin-url-install-download");
    expect(downloadUrlMock).toHaveBeenCalledWith("https://e.com/p.termihub-plugin", SHA);
    expect(q("install-dialog")!.textContent).toContain("url-x.termihub-plugin");
  });
});

describe("catalog helpers", () => {
  it("matches search on name, id, author and description", () => {
    const v = view("alpha");
    expect(entryMatches(v, "")).toBe(true);
    expect(entryMatches(v, "PLUGIN ALPHA")).toBe(true);
    expect(entryMatches(v, "jane")).toBe(true);
    expect(entryMatches(v, "alpha things")).toBe(true);
    expect(entryMatches(v, "nothing")).toBe(false);
  });

  it("validates URL and checksum fields", () => {
    expect(urlFieldError("")).toBeNull();
    expect(urlFieldError("https://e.com/x")).toBeNull();
    expect(urlFieldError("http://e.com/x")).not.toBeNull();
    expect(urlFieldError("file:///etc/passwd")).not.toBeNull();
    expect(shaFieldError("")).toBeNull();
    expect(shaFieldError(SHA.toUpperCase())).toBeNull();
    expect(shaFieldError("abc")).not.toBeNull();
  });
});
