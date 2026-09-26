import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import React from "react";

vi.mock("@/services/api", () => ({
  localListDir: vi.fn(() => Promise.resolve([])),
  sessionListFiles: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/components/ui", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { toast } from "@/components/ui";
import { localListDir, sessionListFiles } from "@/services/api";
import type { FileEntry } from "@/types/connection";
import type { PasteOptions } from "@/utils/fileDragMove";
import {
  useFileMoveTransfer,
  type FileMoveTransfer,
  type UseFileMoveTransferArgs,
} from "./useFileMoveTransfer";

function entry(path: string, isDirectory = false, writable: boolean | null = null): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    isDirectory,
    size: 0,
    modified: "",
    permissions: null,
    writable,
  };
}

describe("useFileMoveTransfer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: FileMoveTransfer;
  let pasteEntry: ReturnType<typeof vi.fn<(options?: PasteOptions) => Promise<void>>>;

  async function mount(args: Partial<UseFileMoveTransferArgs> = {}) {
    function Harness() {
      api = useFileMoveTransfer({
        mode: "local",
        sessionId: null,
        pasteEntry,
        ...args,
      });
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    pasteEntry = vi.fn<(options?: PasteOptions) => Promise<void>>(() => Promise.resolve());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("moves a local entry into a folder as a one-shot cut clipboard", async () => {
    await mount();
    const f = entry("/home/u/a.txt");
    await act(async () => {
      await api.requestTransfer([f], "/home/u/docs", "move");
    });
    expect(localListDir).toHaveBeenCalledWith("/home/u/docs");
    expect(pasteEntry).toHaveBeenCalledWith({
      clipboard: {
        entries: [f],
        operation: "cut",
        sourceMode: "local",
        sourcePath: "/home/u",
        terminalSessionId: null,
      },
      destDir: "/home/u/docs",
      verb: "Move",
    });
    expect(toast.success).toHaveBeenCalledWith('Moved "a.txt" to /home/u/docs', expect.anything());
  });

  it("copies (Alt/Option drop) with a copy clipboard", async () => {
    await mount();
    const f = entry("/home/u/a.txt");
    await act(async () => {
      await api.requestTransfer([f], "/home/u/docs", "copy");
    });
    expect(pasteEntry.mock.calls[0][0]?.clipboard?.operation).toBe("copy");
    expect(pasteEntry.mock.calls[0][0]?.verb).toBe("Copy");
  });

  it("routes a session move through the session's paste with its session id", async () => {
    await mount({ mode: "session", sessionId: "ssh-1" });
    const f = entry("/srv/a.txt");
    await act(async () => {
      await api.requestTransfer([f], "/srv/sub", "move");
    });
    expect(sessionListFiles).toHaveBeenCalledWith("ssh-1", "/srv/sub");
    expect(pasteEntry.mock.calls[0][0]?.clipboard).toMatchObject({
      sourceMode: "session",
      terminalSessionId: "ssh-1",
      operation: "cut",
    });
  });

  it("refuses moving a folder into its own descendant without touching the filesystem", async () => {
    await mount();
    const d = entry("/home/u/docs", true);
    await act(async () => {
      await api.requestTransfer([d], "/home/u/docs/sub", "move");
    });
    expect(toast.error).toHaveBeenCalledWith('Cannot move "docs" into itself');
    expect(localListDir).not.toHaveBeenCalled();
    expect(pasteEntry).not.toHaveBeenCalled();
  });

  it("refuses a read-only destination folder", async () => {
    await mount({ mode: "session", sessionId: "ftp-1" });
    const dest = entry("/pub/locked", true, false);
    await act(async () => {
      await api.requestTransfer([entry("/pub/a.txt")], dest.path, "move", dest);
    });
    expect(toast.error).toHaveBeenCalledWith('"locked" is read-only');
    expect(pasteEntry).not.toHaveBeenCalled();
  });

  it("asks before replacing an existing name, then runs on confirm", async () => {
    vi.mocked(localListDir).mockResolvedValueOnce([entry("/home/u/docs/a.txt")]);
    await mount();
    const f = entry("/home/u/a.txt");
    await act(async () => {
      await api.requestTransfer([f], "/home/u/docs", "move");
    });
    expect(pasteEntry).not.toHaveBeenCalled();
    expect(api.pendingConflict).toMatchObject({ conflicts: ["a.txt"], destDir: "/home/u/docs" });
    await act(async () => {
      await api.confirmConflict();
    });
    expect(pasteEntry).toHaveBeenCalledTimes(1);
    expect(api.pendingConflict).toBeNull();
  });

  it("drops the request when the conflict prompt is cancelled", async () => {
    vi.mocked(localListDir).mockResolvedValueOnce([entry("/home/u/docs/a.txt")]);
    await mount();
    await act(async () => {
      await api.requestTransfer([entry("/home/u/a.txt")], "/home/u/docs", "move");
    });
    act(() => api.cancelConflict());
    expect(api.pendingConflict).toBeNull();
    expect(pasteEntry).not.toHaveBeenCalled();
  });

  it("asks for confirmation when the destination cannot be listed", async () => {
    vi.mocked(localListDir).mockRejectedValueOnce(new Error("EACCES"));
    await mount();
    await act(async () => {
      await api.requestTransfer([entry("/home/u/a.txt")], "/home/u/docs", "move");
    });
    expect(api.pendingConflict?.conflicts).toBeNull();
    expect(pasteEntry).not.toHaveBeenCalled();
  });

  it("does nothing for a drop into the entry's current folder", async () => {
    await mount();
    await act(async () => {
      await api.requestTransfer([entry("/home/u/a.txt")], "/home/u", "move");
    });
    expect(localListDir).not.toHaveBeenCalled();
    expect(pasteEntry).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
