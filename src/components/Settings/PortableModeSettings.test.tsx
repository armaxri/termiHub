import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  listConfigFiles: vi.fn(() => Promise.resolve([])),
  exportConfigToPortable: vi.fn(() =>
    Promise.resolve({ filesCopied: ["connections.json"], warnings: [] })
  ),
  importConfigFromPortable: vi.fn(() =>
    Promise.resolve({ filesCopied: ["connections.json"], warnings: [] })
  ),
}));

import { PortableModeSettings } from "./PortableModeSettings";

describe("PortableModeSettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the settings section", async () => {
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    expect(container.querySelector('[data-testid="portable-mode-settings"]')).not.toBeNull();
  });

  it("shows Inactive status in installed mode", async () => {
    useAppStore.setState({ isPortableMode: false, portableDataDir: null });
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    const status = container.querySelector('[data-testid="portable-mode-status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("Inactive");
  });

  it("shows Active status in portable mode", async () => {
    useAppStore.setState({ isPortableMode: true, portableDataDir: "/tmp/portable/data" });
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    const status = container.querySelector('[data-testid="portable-mode-status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("Active");
  });

  it("shows the data directory path in portable mode", async () => {
    useAppStore.setState({ isPortableMode: true, portableDataDir: "/tmp/portable/data" });
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    const dataDir = container.querySelector('[data-testid="portable-data-dir"]');
    expect(dataDir).not.toBeNull();
    expect(dataDir!.textContent).toBe("/tmp/portable/data");
  });

  it("hides data directory path in installed mode", async () => {
    useAppStore.setState({ isPortableMode: false, portableDataDir: null });
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    expect(container.querySelector('[data-testid="portable-data-dir"]')).toBeNull();
  });

  it("shows info box about enabling portable mode in installed mode", async () => {
    useAppStore.setState({ isPortableMode: false });
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    const text = container.textContent ?? "";
    expect(text).toContain("portable.marker");
    expect(text).toContain("data/");
  });

  it("shows export and import buttons", async () => {
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    expect(container.querySelector('[data-testid="export-config-btn"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="import-config-btn"]')).not.toBeNull();
  });

  it("loads config file list when in portable mode", async () => {
    const { listConfigFiles } = await import("@/services/api");
    const mockListConfigFiles = vi.mocked(listConfigFiles);
    mockListConfigFiles.mockResolvedValue([
      { name: "connections.json", present: true },
      { name: "settings.json", present: false },
    ]);

    useAppStore.setState({ isPortableMode: true, portableDataDir: "/data" });

    await act(async () => {
      root.render(<PortableModeSettings />);
    });

    expect(mockListConfigFiles).toHaveBeenCalledWith("/data");
  });

  it("shows a persistent error toast when the config file list cannot be loaded (#4333)", async () => {
    const { listConfigFiles } = await import("@/services/api");
    const { toast } = await import("@/components/ui");
    const errorSpy = vi.spyOn(toast, "error");
    vi.mocked(listConfigFiles).mockRejectedValueOnce({ code: "io", message: "data dir gone" });
    useAppStore.setState({ isPortableMode: true, portableDataDir: "/data" });

    await act(async () => {
      root.render(<PortableModeSettings />);
    });

    expect(errorSpy).toHaveBeenCalledWith("Could not list portable config files", {
      description: "data dir gone",
    });
    errorSpy.mockRestore();
  });

  it("does not load config files in installed mode", async () => {
    const { listConfigFiles } = await import("@/services/api");
    const mockListConfigFiles = vi.mocked(listConfigFiles);

    useAppStore.setState({ isPortableMode: false, portableDataDir: null });

    await act(async () => {
      root.render(<PortableModeSettings />);
    });

    expect(mockListConfigFiles).not.toHaveBeenCalled();
  });

  it("renders a structured IPC error's message when export fails (#4104)", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { exportConfigToPortable } = await import("@/services/api");
    vi.mocked(open).mockResolvedValueOnce("/target");
    vi.mocked(exportConfigToPortable).mockRejectedValueOnce({
      code: "io_error",
      message: "target directory is read-only",
    });

    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="export-config-btn"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="migration-confirm"]')!.click();
    });

    const result = container.querySelector('[data-testid="migration-result"]');
    expect(result?.textContent).toContain("target directory is read-only");
    expect(result?.textContent).not.toContain("[object Object]");
  });

  describe("config migration (#5304)", () => {
    async function setup() {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const api = await import("@/services/api");
      return {
        open: vi.mocked(dialog.open),
        listConfigFiles: vi.mocked(api.listConfigFiles),
        exportConfigToPortable: vi.mocked(api.exportConfigToPortable),
        importConfigFromPortable: vi.mocked(api.importConfigFromPortable),
      };
    }

    const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);

    async function clickTestId(testId: string) {
      await act(async () => {
        q<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
      });
    }

    function fileCheckbox(name: string) {
      return q<HTMLButtonElement>(`[role="checkbox"][aria-label="${name}"]`)!;
    }

    async function renderPanel() {
      await act(async () => {
        root.render(<PortableModeSettings />);
      });
    }

    it("a cancelled export dialog lists nothing, opens no dialog and copies nothing", async () => {
      const m = await setup();
      m.open.mockResolvedValueOnce(null);
      await renderPanel();

      await clickTestId("export-config-btn");

      expect(m.open).toHaveBeenCalledWith({ directory: true, multiple: false });
      expect(m.listConfigFiles).not.toHaveBeenCalled();
      expect(q('[data-testid="migration-dialog"]')).toBeNull();
      expect(q('[data-testid="migration-result"]')).toBeNull();
      expect(m.exportConfigToPortable).not.toHaveBeenCalled();
    });

    it("a cancelled import dialog does nothing", async () => {
      const m = await setup();
      m.open.mockResolvedValueOnce(null);
      await renderPanel();

      await clickTestId("import-config-btn");

      expect(m.listConfigFiles).not.toHaveBeenCalled();
      expect(q('[data-testid="migration-dialog"]')).toBeNull();
      expect(m.importConfigFromPortable).not.toHaveBeenCalled();
    });

    it("the export picker passes the chosen directory through to the copy", async () => {
      const m = await setup();
      m.open.mockResolvedValueOnce("/media/usb/termihub/data");
      // The destination already holds settings.json, so it is not offered for export.
      m.listConfigFiles.mockResolvedValueOnce([
        { name: "connections.json", present: false },
        { name: "settings.json", present: true },
      ]);
      m.exportConfigToPortable.mockResolvedValueOnce({
        filesCopied: ["connections.json", "tunnels.json"],
        warnings: ["credentials.enc skipped"],
      });
      await renderPanel();

      await clickTestId("export-config-btn");

      expect(m.listConfigFiles).toHaveBeenCalledWith("/media/usb/termihub/data");
      const dialog = q('[data-testid="migration-dialog"]')!;
      expect(dialog.textContent).toContain("Export Config to Portable");
      expect(dialog.textContent).toContain("/media/usb/termihub/data");
      expect(fileCheckbox("settings.json").disabled).toBe(true);

      // Deselect workspaces.json; the rest of the offered files stay selected.
      await act(async () => {
        fileCheckbox("workspaces.json").click();
      });
      await clickTestId("migration-confirm");

      expect(m.exportConfigToPortable).toHaveBeenCalledTimes(1);
      expect(m.exportConfigToPortable).toHaveBeenCalledWith("/media/usb/termihub/data", [
        "connections.json",
        "tunnels.json",
        "credentials.enc",
      ]);
      expect(q('[data-testid="migration-dialog"]')).toBeNull();
      const result = q('[data-testid="migration-result"]')!;
      expect(result.classList.contains("portable-mode__result--success")).toBe(true);
      expect(result.textContent).toBe(
        "Copied 2 file(s) to /media/usb/termihub/data (credentials.enc skipped)"
      );
    });

    it("uses the first entry when the picker returns an array", async () => {
      const m = await setup();
      m.open.mockResolvedValueOnce(["/picked/a", "/picked/b"] as unknown as string);
      await renderPanel();

      await clickTestId("export-config-btn");

      expect(m.listConfigFiles).toHaveBeenCalledWith("/picked/a");
    });

    it("toggling a file off and on again changes the import selection", async () => {
      const m = await setup();
      m.open.mockResolvedValueOnce("/portable/data");
      m.listConfigFiles.mockResolvedValueOnce([
        { name: "connections.json", present: true },
        { name: "settings.json", present: true },
        { name: "tunnels.json", present: false },
      ]);
      await renderPanel();
      await clickTestId("import-config-btn");

      // Present files start selected; the missing one is disabled and unselected.
      expect(fileCheckbox("connections.json").getAttribute("aria-checked")).toBe("true");
      expect(fileCheckbox("settings.json").getAttribute("aria-checked")).toBe("true");
      expect(fileCheckbox("tunnels.json").getAttribute("aria-checked")).toBe("false");
      expect(fileCheckbox("tunnels.json").disabled).toBe(true);
      expect(q('[data-testid="migration-dialog"]')!.textContent).toContain("not found");

      await act(async () => {
        fileCheckbox("connections.json").click();
      });
      expect(fileCheckbox("connections.json").getAttribute("aria-checked")).toBe("false");
      await act(async () => {
        fileCheckbox("settings.json").click();
      });
      // Nothing selected: Copy is disabled.
      expect(q<HTMLButtonElement>('[data-testid="migration-confirm"]')!.disabled).toBe(true);

      await act(async () => {
        fileCheckbox("connections.json").click();
      });
      expect(fileCheckbox("connections.json").getAttribute("aria-checked")).toBe("true");
      await clickTestId("migration-confirm");

      expect(m.importConfigFromPortable).toHaveBeenCalledWith("/portable/data", [
        "connections.json",
      ]);
    });

    it("cancel in the migration dialog closes it without copying", async () => {
      const m = await setup();
      m.open.mockResolvedValueOnce("/portable/data");
      m.listConfigFiles.mockResolvedValueOnce([{ name: "connections.json", present: true }]);
      await renderPanel();
      await clickTestId("import-config-btn");
      expect(q('[data-testid="migration-dialog"]')).not.toBeNull();

      await clickTestId("migration-cancel");

      expect(q('[data-testid="migration-dialog"]')).toBeNull();
      expect(m.importConfigFromPortable).not.toHaveBeenCalled();
      expect(q('[data-testid="migration-result"]')).toBeNull();
    });

    it("a rejected import renders the failure result and migrates nothing else", async () => {
      const m = await setup();
      m.open.mockResolvedValueOnce("/portable/data");
      m.listConfigFiles.mockResolvedValueOnce([
        { name: "connections.json", present: true },
        { name: "settings.json", present: true },
      ]);
      m.importConfigFromPortable.mockRejectedValueOnce({
        code: "io_error",
        message: "source directory is unreadable",
      });
      await renderPanel();
      await clickTestId("import-config-btn");
      await clickTestId("migration-confirm");

      expect(m.importConfigFromPortable).toHaveBeenCalledTimes(1);
      expect(m.importConfigFromPortable).toHaveBeenCalledWith("/portable/data", [
        "connections.json",
        "settings.json",
      ]);
      expect(m.exportConfigToPortable).not.toHaveBeenCalled();

      const result = q('[data-testid="migration-result"]')!;
      expect(result.classList.contains("portable-mode__result--error")).toBe(true);
      expect(result.textContent).toBe("source directory is unreadable");
      expect(result.textContent).not.toContain("Copied");

      // The dialog stays open (not running any more) so the user can retry or cancel.
      expect(q('[data-testid="migration-dialog"]')).not.toBeNull();
      const confirm = q<HTMLButtonElement>('[data-testid="migration-confirm"]')!;
      expect(confirm.disabled).toBe(false);
      expect(confirm.textContent).toBe("Copy");
    });

    it("shows Copying… and disables the dialog while the import runs", async () => {
      const m = await setup();
      m.open.mockResolvedValueOnce("/portable/data");
      m.listConfigFiles.mockResolvedValueOnce([{ name: "connections.json", present: true }]);
      let resolveImport!: (v: { filesCopied: string[]; warnings: string[] }) => void;
      m.importConfigFromPortable.mockReturnValueOnce(
        new Promise((r) => {
          resolveImport = r;
        })
      );
      await renderPanel();
      await clickTestId("import-config-btn");
      await clickTestId("migration-confirm");

      const confirm = q<HTMLButtonElement>('[data-testid="migration-confirm"]')!;
      expect(confirm.textContent).toBe("Copying…");
      expect(confirm.disabled).toBe(true);
      expect(q<HTMLButtonElement>('[data-testid="migration-cancel"]')!.disabled).toBe(true);
      expect(fileCheckbox("connections.json").disabled).toBe(true);

      await act(async () => {
        resolveImport({ filesCopied: ["connections.json"], warnings: [] });
      });
      expect(q('[data-testid="migration-dialog"]')).toBeNull();
    });

    it("a successful import renders success and closes the dialog", async () => {
      const m = await setup();
      m.open.mockResolvedValueOnce("/portable/data");
      m.listConfigFiles.mockResolvedValueOnce([
        { name: "connections.json", present: true },
        { name: "settings.json", present: true },
      ]);
      m.importConfigFromPortable.mockResolvedValueOnce({
        filesCopied: ["connections.json", "settings.json"],
        warnings: [],
      });
      await renderPanel();
      await clickTestId("import-config-btn");

      expect(q('[data-testid="migration-dialog"]')!.textContent).toContain(
        "Import Config from Portable"
      );
      await clickTestId("migration-confirm");

      expect(q('[data-testid="migration-dialog"]')).toBeNull();
      const result = q('[data-testid="migration-result"]')!;
      expect(result.classList.contains("portable-mode__result--success")).toBe(true);
      expect(result.textContent).toBe("Copied 2 file(s) from /portable/data");
    });

    it.each(["export-config-btn", "import-config-btn"])(
      "a failed listing of the picked directory renders a failure result (%s)",
      async (button) => {
        const m = await setup();
        m.open.mockResolvedValueOnce("/unreadable");
        m.listConfigFiles.mockRejectedValueOnce({ code: "io", message: "permission denied" });
        await renderPanel();

        await clickTestId(button);

        expect(q('[data-testid="migration-dialog"]')).toBeNull();
        const result = q('[data-testid="migration-result"]')!;
        expect(result.classList.contains("portable-mode__result--error")).toBe(true);
        expect(result.textContent).toBe("permission denied");
        expect(m.exportConfigToPortable).not.toHaveBeenCalled();
        expect(m.importConfigFromPortable).not.toHaveBeenCalled();
      }
    );

    it("starting a new migration clears the previous result", async () => {
      const m = await setup();
      m.open.mockResolvedValueOnce("/portable/data").mockResolvedValueOnce("/portable/data");
      m.listConfigFiles.mockResolvedValue([{ name: "connections.json", present: true }]);
      m.importConfigFromPortable.mockRejectedValueOnce(new Error("boom"));
      await renderPanel();
      await clickTestId("import-config-btn");
      await clickTestId("migration-confirm");
      expect(q('[data-testid="migration-result"]')).not.toBeNull();

      await clickTestId("import-config-btn");
      expect(q('[data-testid="migration-result"]')).toBeNull();
    });
  });
});
