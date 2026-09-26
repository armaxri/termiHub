import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { save } from "@tauri-apps/plugin-dialog";
import * as api from "@/services/api";
import { DiagnosticsExportDialog, defaultDiagnosticsFileName } from "./DiagnosticsExportDialog";
import { useDiagnosticsDialogStore } from "./diagnosticsDialogStore";

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    previewDiagnosticsBundle: vi.fn(),
    exportDiagnosticsBundle: vi.fn(),
  };
});

const mockedApi = vi.mocked(api);
const mockedSave = vi.mocked(save);

const ENTRIES = [
  { name: "README.txt", size: 400, description: "What this bundle contains" },
  { name: "system-info.txt", size: 200, description: "App version, build and platform" },
  { name: "logs/termihub.log", size: 2048, description: "Application log" },
  {
    name: "crash-reports/crash-20260926T120102Z-1.txt",
    size: 900,
    description: "Crash report",
  },
];

let container: HTMLDivElement;
let root: Root;

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

async function renderOpen() {
  await act(async () => {
    root.render(<DiagnosticsExportDialog />);
  });
  await act(async () => {
    useDiagnosticsDialogStore.getState().setExportOpen(true);
  });
}

async function clickSave() {
  await act(async () => {
    byTestId("diagnostics-export-save")?.click();
  });
}

describe("DiagnosticsExportDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useDiagnosticsDialogStore.setState({ exportOpen: false, viewedReport: null });
    mockedApi.previewDiagnosticsBundle.mockResolvedValue(ENTRIES);
    mockedApi.exportDiagnosticsBundle.mockResolvedValue({ path: "/tmp/d.zip", fileCount: 4 });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("lists every file the bundle will include before saving", async () => {
    await renderOpen();
    const list = byTestId("diagnostics-export-files");
    expect(list).not.toBeNull();
    for (const e of ENTRIES) expect(list?.textContent).toContain(e.name);
    expect(mockedApi.exportDiagnosticsBundle).not.toHaveBeenCalled();
  });

  it("writes to the destination the user picked", async () => {
    mockedSave.mockResolvedValue("/Users/me/Desktop/diag.zip");
    await renderOpen();
    await clickSave();
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedApi.exportDiagnosticsBundle).toHaveBeenCalledWith("/Users/me/Desktop/diag.zip");
    expect(useDiagnosticsDialogStore.getState().exportOpen).toBe(false);
  });

  it("writes nothing when the save dialog is cancelled", async () => {
    mockedSave.mockResolvedValue(null);
    await renderOpen();
    await clickSave();
    expect(mockedApi.exportDiagnosticsBundle).not.toHaveBeenCalled();
    expect(useDiagnosticsDialogStore.getState().exportOpen).toBe(true);
  });

  it("shows an inline error when the export fails", async () => {
    mockedSave.mockResolvedValue("/tmp/d.zip");
    mockedApi.exportDiagnosticsBundle.mockRejectedValue(new Error("disk full"));
    await renderOpen();
    await clickSave();
    expect(byTestId("diagnostics-export-error")?.textContent).toContain("disk full");
  });

  it("suggests a dated zip file name", () => {
    expect(defaultDiagnosticsFileName(new Date("2026-09-26T12:00:00Z"))).toBe(
      "termihub-diagnostics-2026-09-26.zip"
    );
  });
});
