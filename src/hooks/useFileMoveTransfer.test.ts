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

let mockClipboard: FileClipboard | null = null;
vi.mock("@/store/fileBrowsersBridge", () => ({
  currentFileBrowsersView: () => ({ clipboard: mockClipboard }),
}));

import { toast } from "@/components/ui";
import { localListDir, sessionListFiles } from "@/services/api";
import type { FileEntry } from "@/types/connection";
import type { FileClipboard } from "@/store/appStore";
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
    mockClipboard = null;
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
    // The pane's paste owns the loading → success/error toast; the engine must
    // not add a second one (#3458).
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.loading).not.toHaveBeenCalled();
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

  describe("requestPaste — the plain Paste (#3458)", () => {
    function clip(overrides: Partial<FileClipboard> & { entries: FileEntry[] }): FileClipboard {
      return {
        operation: "copy",
        sourceMode: "local",
        sourcePath: "/src",
        terminalSessionId: null,
        ...overrides,
      };
    }

    it("does nothing with an empty clipboard", async () => {
      await mount();
      await act(async () => {
        await api.requestPaste("/home/u");
      });
      expect(localListDir).not.toHaveBeenCalled();
      expect(pasteEntry).not.toHaveBeenCalled();
    });

    it("pastes the user clipboard into the folder after a conflict check", async () => {
      mockClipboard = clip({ entries: [entry("/src/a.txt")] });
      await mount();
      await act(async () => {
        await api.requestPaste("/home/u");
      });
      expect(localListDir).toHaveBeenCalledWith("/home/u");
      // No one-shot clipboard: the pane pastes (and on cut clears) the user's own.
      expect(pasteEntry).toHaveBeenCalledWith({ destDir: "/home/u" });
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("confirms a name clash before a session paste, then pastes the user clipboard", async () => {
      vi.mocked(sessionListFiles).mockResolvedValueOnce([entry("/srv/a.txt")]);
      mockClipboard = clip({ entries: [entry("/src/a.txt")] });
      await mount({ mode: "session", sessionId: "ssh-1" });
      await act(async () => {
        await api.requestPaste("/srv");
      });
      expect(sessionListFiles).toHaveBeenCalledWith("ssh-1", "/srv");
      expect(api.pendingConflict).toMatchObject({
        conflicts: ["a.txt"],
        destDir: "/srv",
        fromClipboard: true,
      });
      expect(pasteEntry).not.toHaveBeenCalled();
      await act(async () => {
        await api.confirmConflict();
      });
      expect(pasteEntry).toHaveBeenCalledWith({ destDir: "/srv" });
    });

    it("cancelling the conflict prompt pastes nothing", async () => {
      vi.mocked(localListDir).mockResolvedValueOnce([entry("/home/u/a.txt")]);
      mockClipboard = clip({ entries: [entry("/src/a.txt")] });
      await mount();
      await act(async () => {
        await api.requestPaste("/home/u");
      });
      act(() => api.cancelConflict());
      expect(pasteEntry).not.toHaveBeenCalled();
    });

    it("refuses a same-session cut of a folder into its own subtree", async () => {
      mockClipboard = clip({
        entries: [entry("/srv/app", true)],
        operation: "cut",
        sourceMode: "session",
        terminalSessionId: "ssh-1",
      });
      await mount({ mode: "session", sessionId: "ssh-1" });
      await act(async () => {
        await api.requestPaste("/srv/app/sub");
      });
      expect(toast.error).toHaveBeenCalledWith('Cannot move "app" into itself');
      expect(sessionListFiles).not.toHaveBeenCalled();
      expect(pasteEntry).not.toHaveBeenCalled();
    });

    it("skips the into-self guard across filesystems (local → session upload)", async () => {
      // "/srv" locally and "/srv/sub" remotely are unrelated paths.
      mockClipboard = clip({ entries: [entry("/srv", true)], sourcePath: "/" });
      await mount({ mode: "session", sessionId: "ssh-1" });
      await act(async () => {
        await api.requestPaste("/srv/sub");
      });
      expect(toast.error).not.toHaveBeenCalled();
      expect(pasteEntry).toHaveBeenCalledWith({ destDir: "/srv/sub" });
    });

    it("tells the user when the items are already in this folder", async () => {
      mockClipboard = clip({ entries: [entry("/home/u/a.txt")], operation: "cut" });
      await mount();
      await act(async () => {
        await api.requestPaste("/home/u");
      });
      expect(toast.info).toHaveBeenCalledWith('"a.txt" is already in /home/u');
      expect(pasteEntry).not.toHaveBeenCalled();
    });

    it("hands an unsupported remote → local paste to the local pane to report", async () => {
      mockClipboard = clip({
        entries: [entry("/srv/a.txt")],
        sourceMode: "session",
        terminalSessionId: "ssh-1",
      });
      await mount();
      await act(async () => {
        await api.requestPaste("/home/u");
      });
      expect(localListDir).not.toHaveBeenCalled();
      expect(pasteEntry).toHaveBeenCalledWith();
    });

    it("does nothing for a session pane that has no live session", async () => {
      mockClipboard = clip({ entries: [entry("/src/a.txt")] });
      await mount({ mode: "session", sessionId: null });
      await act(async () => {
        await api.requestPaste("/srv");
      });
      expect(localListDir).not.toHaveBeenCalled();
      expect(pasteEntry).not.toHaveBeenCalled();
    });
  });
});
