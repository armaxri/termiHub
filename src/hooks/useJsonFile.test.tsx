import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

const dialogSave = vi.fn();
const dialogOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => dialogSave(...args),
  open: (...args: unknown[]) => dialogOpen(...args),
}));

const fsWriteTextFile = vi.fn();
const fsReadTextFile = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...args: unknown[]) => fsWriteTextFile(...args),
  readTextFile: (...args: unknown[]) => fsReadTextFile(...args),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@/components/ui", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

import { useJsonFileExport, useJsonFileImport, JsonFileExportOptions } from "./useJsonFile";

let exportFn: (options: JsonFileExportOptions) => Promise<void>;
let importFn: (onParsed: (json: string) => void | Promise<void>) => Promise<void>;

function Harness() {
  exportFn = useJsonFileExport("macros");
  importFn = useJsonFileImport("macros");
  return null;
}

describe("useJsonFileExport / useJsonFileImport", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  describe("export", () => {
    it("writes the content to the chosen file and toasts success", async () => {
      dialogSave.mockResolvedValue("/out/macros.json");
      fsWriteTextFile.mockResolvedValue(undefined);
      await act(async () => {
        await exportFn({
          defaultPath: "termihub-macros.json",
          content: "DATA",
          successMessage: "Exported 2 macros",
        });
      });
      expect(fsWriteTextFile).toHaveBeenCalledWith("/out/macros.json", "DATA");
      expect(toastSuccess).toHaveBeenCalledWith("Exported 2 macros");
      expect(toastError).not.toHaveBeenCalled();
    });

    it("resolves an async content factory before writing", async () => {
      dialogSave.mockResolvedValue("/out/macros.json");
      fsWriteTextFile.mockResolvedValue(undefined);
      await act(async () => {
        await exportFn({
          defaultPath: "x.json",
          content: async () => "GENERATED",
          successMessage: "ok",
        });
      });
      expect(fsWriteTextFile).toHaveBeenCalledWith("/out/macros.json", "GENERATED");
    });

    it("is a silent no-op when the save dialog is cancelled", async () => {
      dialogSave.mockResolvedValue(null);
      await act(async () => {
        await exportFn({ defaultPath: "x.json", content: "DATA", successMessage: "ok" });
      });
      expect(fsWriteTextFile).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    });

    it("surfaces a labelled error toast when the write fails", async () => {
      dialogSave.mockResolvedValue("/out/macros.json");
      fsWriteTextFile.mockRejectedValue(new Error("disk full"));
      await act(async () => {
        await exportFn({ defaultPath: "x.json", content: "DATA", successMessage: "ok" });
      });
      expect(toastError).toHaveBeenCalledWith("Failed to export macros: disk full");
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("surfaces a content-factory failure without opening the save dialog", async () => {
      await act(async () => {
        await exportFn({
          defaultPath: "x.json",
          content: () => {
            throw new Error("serialize boom");
          },
          successMessage: "ok",
        });
      });
      expect(dialogSave).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith("Failed to export macros: serialize boom");
    });
  });

  describe("import", () => {
    it("reads the chosen file and hands its text to onParsed", async () => {
      dialogOpen.mockResolvedValue("/in/macros.json");
      fsReadTextFile.mockResolvedValue('{"macros":[]}');
      const onParsed = vi.fn();
      await act(async () => {
        await importFn(onParsed);
      });
      expect(onParsed).toHaveBeenCalledWith('{"macros":[]}');
      expect(toastError).not.toHaveBeenCalled();
    });

    it("is a silent no-op when the open dialog is cancelled", async () => {
      dialogOpen.mockResolvedValue(null);
      const onParsed = vi.fn();
      await act(async () => {
        await importFn(onParsed);
      });
      expect(fsReadTextFile).not.toHaveBeenCalled();
      expect(onParsed).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    });

    it("ignores a multi-selection array result", async () => {
      dialogOpen.mockResolvedValue(["/a.json", "/b.json"]);
      const onParsed = vi.fn();
      await act(async () => {
        await importFn(onParsed);
      });
      expect(fsReadTextFile).not.toHaveBeenCalled();
      expect(onParsed).not.toHaveBeenCalled();
    });

    it("surfaces a labelled error toast when the read fails", async () => {
      dialogOpen.mockResolvedValue("/in/macros.json");
      fsReadTextFile.mockRejectedValue(new Error("nope"));
      const onParsed = vi.fn();
      await act(async () => {
        await importFn(onParsed);
      });
      expect(onParsed).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith("Failed to import macros: nope");
    });

    it("surfaces a labelled error toast when onParsed throws", async () => {
      dialogOpen.mockResolvedValue("/in/macros.json");
      fsReadTextFile.mockResolvedValue("{ bad json");
      await act(async () => {
        await importFn(() => {
          throw new Error("parse failed");
        });
      });
      expect(toastError).toHaveBeenCalledWith("Failed to import macros: parse failed");
    });
  });
});
