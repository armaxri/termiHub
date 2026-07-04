import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ExportDialog } from "./ExportDialog";

vi.mock("@/services/api", () => ({
  exportConnectionsEncrypted: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn(),
}));

import { exportConnectionsEncrypted } from "@/services/api";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

const mockedExport = vi.mocked(exportConnectionsEncrypted);
const mockedSave = vi.mocked(save);
const mockedWrite = vi.mocked(writeTextFile);

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

describe("ExportDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not render when closed", () => {
    act(() => root.render(<ExportDialog />));
    expect(document.querySelector(".ui-modal")).toBeNull();
  });

  it("renders through the Modal primitive when open", () => {
    useAppStore.setState({ exportDialogOpen: true });
    act(() => root.render(<ExportDialog />));

    expect(document.querySelector(".ui-modal")).not.toBeNull();
    expect(query("export-dialog-title")).not.toBeNull();
    expect(query("export-submit")).not.toBeNull();
  });

  it("fires the export action (plain mode) on submit", async () => {
    mockedExport.mockResolvedValueOnce("{}");
    mockedSave.mockResolvedValueOnce("/tmp/out.json");
    mockedWrite.mockResolvedValueOnce(undefined);
    useAppStore.setState({ exportDialogOpen: true });

    act(() => root.render(<ExportDialog />));

    const submit = query("export-submit") as HTMLButtonElement;
    await act(async () => {
      submit.click();
    });

    expect(mockedExport).toHaveBeenCalledWith(null, null);
  });
});
