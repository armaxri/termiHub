import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/api", () => ({
  folderPasteBegin: vi.fn(() => Promise.resolve("paste-2")),
  folderPasteEnd: vi.fn(() => Promise.resolve()),
  folderPasteLinkTransfer: vi.fn(() => Promise.resolve()),
  localListDir: vi.fn(() => Promise.resolve([])),
  sessionCopy: vi.fn(() => Promise.resolve()),
  sessionCopyRemote: vi.fn(() => Promise.resolve(0)),
  sessionDeleteFile: vi.fn(() => Promise.resolve()),
  sessionHasExecCapability: vi.fn(() => Promise.reject(new Error("not sftp-backed"))),
  sessionListFiles: vi.fn(() => Promise.resolve([])),
  sessionMkdir: vi.fn(() => Promise.resolve()),
  sessionReadFile: vi.fn(() => Promise.resolve(new Uint8Array([1]))),
  sessionRenameFile: vi.fn(() => Promise.resolve()),
  sessionSupportsTransferQueue: vi.fn(() => Promise.resolve(false)),
  sessionUpload: vi.fn(() => Promise.resolve(0)),
  sessionWriteFile: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/store/layoutSelectors", () => ({
  getAllTabsAcrossGroupTrees: vi.fn(() => []),
}));

vi.mock("./transferFeedback", () => ({
  seedTransferQueueRow: vi.fn(),
}));

import {
  folderPasteBegin,
  folderPasteEnd,
  folderPasteLinkTransfer,
  localListDir,
  sessionCopyRemote,
  sessionListFiles,
  sessionMkdir,
  sessionReadFile,
  sessionRenameFile,
  sessionUpload,
  sessionWriteFile,
  type InterruptedFolderPaste,
} from "@/services/api";
import { getAllTabsAcrossGroupTrees } from "@/store/layoutSelectors";
import type { FileEntry } from "@/types/connection";
import type { TerminalTab } from "@/types/terminal";
import {
  FolderPasteEndpointUnavailable,
  pasteFolderRecorded,
  pasteFolderTree,
  resolveLiveSession,
  retryInterruptedFolderPaste,
  type PasteTransport,
} from "./sessionFolderPaste";

function entry(name: string, path: string, size: number, isDirectory = false): FileEntry {
  return { name, path, isDirectory, size, modified: "", permissions: null, writable: null };
}

function tab(sessionId: string | null, connectionId?: string): TerminalTab {
  return { sessionId, connectionId, title: `tab-${connectionId}` } as TerminalTab;
}

const byteTransport: PasteTransport = {
  operation: "copy",
  sourceMode: "session",
  srcSession: "agent-src",
  destSession: "agent-dst",
  srcSftp: false,
  destSftp: false,
  destQueueCapable: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllTabsAcrossGroupTrees).mockReturnValue([]);
  vi.mocked(sessionListFiles).mockResolvedValue([]);
});

describe("pasteFolderTree — continuing an interrupted paste (#3630)", () => {
  it("copies only the files the destination lacks or holds partly", async () => {
    vi.mocked(sessionListFiles).mockImplementation(async (id, path) => {
      if (id === "agent-src" && path === "/src/f") {
        return [
          entry("done.txt", "/src/f/done.txt", 10),
          entry("partial.txt", "/src/f/partial.txt", 10),
          entry("missing.txt", "/src/f/missing.txt", 10),
        ];
      }
      if (id === "agent-dst" && path === "/dst/f") {
        return [
          entry("done.txt", "/dst/f/done.txt", 10),
          entry("partial.txt", "/dst/f/partial.txt", 4),
        ];
      }
      return [];
    });

    await pasteFolderTree({ ...byteTransport, continueExisting: true }, "/src/f", "/dst/f");

    // The existing destination folder is reused, not re-created.
    expect(vi.mocked(sessionMkdir)).not.toHaveBeenCalled();
    const read = vi.mocked(sessionReadFile).mock.calls.map((c) => c[1]);
    expect(read).toEqual(["/src/f/partial.txt", "/src/f/missing.txt"]);
    expect(vi.mocked(sessionWriteFile)).toHaveBeenCalledTimes(2);
  });

  it("creates a destination folder that does not exist yet", async () => {
    vi.mocked(sessionListFiles).mockImplementation(async (id, path) => {
      if (id === "agent-dst") throw new Error(`no such dir ${path}`);
      return path === "/src/f" ? [entry("a.txt", "/src/f/a.txt", 3)] : [];
    });

    await pasteFolderTree({ ...byteTransport, continueExisting: true }, "/src/f", "/dst/f");

    expect(vi.mocked(sessionMkdir)).toHaveBeenCalledWith("agent-dst", "/dst/f");
    expect(vi.mocked(sessionReadFile)).toHaveBeenCalledWith("agent-src", "/src/f/a.txt");
  });

  it("never takes the same-session rename shortcut when continuing a move", async () => {
    vi.mocked(sessionListFiles).mockImplementation(async (_id, path) =>
      path === "/src/f" ? [entry("a.txt", "/src/f/a.txt", 3)] : []
    );
    const sameSessionMove: PasteTransport = {
      ...byteTransport,
      operation: "cut",
      srcSession: "agent-dst",
      continueExisting: true,
    };

    await pasteFolderTree(sameSessionMove, "/src/f", "/dst/f");

    // The file is moved on its own; the folder itself is never renamed onto
    // the partly copied destination.
    expect(vi.mocked(sessionRenameFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessionRenameFile)).toHaveBeenCalledWith(
      "agent-dst",
      "/src/f/a.txt",
      "/dst/f/a.txt"
    );
  });
});

describe("pasteFolderRecorded — linking files to the manifest (#3643)", () => {
  const uploadTransport: PasteTransport = {
    operation: "copy",
    sourceMode: "local",
    srcSession: null,
    destSession: "sftp-dst",
    srcSftp: false,
    destSftp: true,
    destQueueCapable: true,
  };

  it("links every tracked upload to the recorded paste", async () => {
    vi.mocked(localListDir).mockResolvedValue([
      entry("a.txt", "/src/f/a.txt", 5),
      entry("b.txt", "/src/f/b.txt", 5),
    ]);
    let n = 0;
    vi.mocked(sessionUpload).mockImplementation(async (_s, _l, _r, onRegistered) => {
      onRegistered?.(`t-${++n}`);
      return 5;
    });

    await pasteFolderRecorded(uploadTransport, "/src/f", "/dst/f");

    expect(vi.mocked(folderPasteLinkTransfer).mock.calls).toEqual([
      ["paste-2", "t-1"],
      ["paste-2", "t-2"],
    ]);
    expect(vi.mocked(folderPasteEnd)).toHaveBeenCalledWith("paste-2");
  });

  it("links a session-to-session streamed copy too", async () => {
    vi.mocked(sessionListFiles).mockImplementation(async (id) =>
      id === "sftp-src" ? [entry("a.txt", "/src/f/a.txt", 5)] : []
    );
    vi.mocked(sessionCopyRemote).mockImplementation(async (_s, _p, _d, _dp, onRegistered) => {
      onRegistered?.("remote-1");
      return 5;
    });

    await pasteFolderRecorded(
      { ...uploadTransport, sourceMode: "session", srcSession: "sftp-src", srcSftp: true },
      "/src/f",
      "/dst/f"
    );

    expect(vi.mocked(folderPasteLinkTransfer)).toHaveBeenCalledWith("paste-2", "remote-1");
  });

  it("links nothing when the paste could not be recorded", async () => {
    vi.mocked(folderPasteBegin).mockRejectedValueOnce(new Error("no persistence"));
    vi.mocked(localListDir).mockResolvedValue([entry("a.txt", "/src/f/a.txt", 5)]);
    vi.mocked(sessionUpload).mockImplementation(async (_s, _l, _r, onRegistered) => {
      onRegistered?.("t-1");
      return 5;
    });

    await pasteFolderRecorded(uploadTransport, "/src/f", "/dst/f");

    expect(vi.mocked(sessionUpload)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(folderPasteLinkTransfer)).not.toHaveBeenCalled();
  });

  it("never fails the paste when linking fails", async () => {
    vi.mocked(folderPasteLinkTransfer).mockRejectedValueOnce(new Error("ipc down"));
    vi.mocked(localListDir).mockResolvedValue([entry("a.txt", "/src/f/a.txt", 5)]);
    vi.mocked(sessionUpload).mockImplementation(async (_s, _l, _r, onRegistered) => {
      onRegistered?.("t-1");
      return 5;
    });

    await expect(pasteFolderRecorded(uploadTransport, "/src/f", "/dst/f")).resolves.toBe(true);
    expect(vi.mocked(folderPasteEnd)).toHaveBeenCalledWith("paste-2");
  });
});

describe("resolveLiveSession", () => {
  it("prefers the recorded session, else the open tab of the same connection", () => {
    vi.mocked(getAllTabsAcrossGroupTrees).mockReturnValue([
      tab(null, "conn-a"),
      tab("new-a", "conn-a"),
      tab("live-b", "conn-b"),
    ]);
    expect(resolveLiveSession({ sessionId: "live-b", path: "/" })).toBe("live-b");
    expect(resolveLiveSession({ sessionId: "gone", connectionId: "conn-a", path: "/" })).toBe(
      "new-a"
    );
    expect(resolveLiveSession({ sessionId: "gone", connectionId: "conn-x", path: "/" })).toBeNull();
    expect(resolveLiveSession({ sessionId: "gone", path: "/" })).toBeNull();
  });
});

describe("retryInterruptedFolderPaste (#3630)", () => {
  const interrupted: InterruptedFolderPaste = {
    id: "old",
    operation: "copy",
    source: { path: "/home/u/proj", label: "Local" },
    destination: { sessionId: "dead", connectionId: "conn-web", label: "web", path: "/srv/proj" },
    startedAtMs: 1,
  };

  it("refuses when the destination connection is not open", async () => {
    await expect(retryInterruptedFolderPaste(interrupted)).rejects.toBeInstanceOf(
      FolderPasteEndpointUnavailable
    );
    expect(vi.mocked(sessionMkdir)).not.toHaveBeenCalled();
    expect(vi.mocked(folderPasteBegin)).not.toHaveBeenCalled();
  });

  it("continues on the reconnected session, recorded as a fresh paste", async () => {
    vi.mocked(getAllTabsAcrossGroupTrees).mockReturnValue([tab("web-2", "conn-web")]);
    vi.mocked(localListDir).mockResolvedValue([
      entry("a.txt", "/home/u/proj/a.txt", 5),
      entry("b.txt", "/home/u/proj/b.txt", 5),
    ]);
    vi.mocked(sessionListFiles).mockResolvedValue([entry("a.txt", "/srv/proj/a.txt", 5)]);
    const { sessionSupportsTransferQueue } = await import("@/services/api");
    vi.mocked(sessionSupportsTransferQueue).mockResolvedValue(true);

    await retryInterruptedFolderPaste(interrupted);

    expect(vi.mocked(folderPasteBegin)).toHaveBeenCalledWith(
      "copy",
      expect.objectContaining({ sessionId: null, path: "/home/u/proj" }),
      expect.objectContaining({ sessionId: "web-2", path: "/srv/proj" })
    );
    // Only the missing file is uploaded, over the reconnected session.
    expect(vi.mocked(sessionUpload)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessionUpload)).toHaveBeenCalledWith(
      "web-2",
      "/home/u/proj/b.txt",
      "/srv/proj/b.txt",
      expect.any(Function)
    );
    expect(vi.mocked(folderPasteEnd)).toHaveBeenCalledWith("paste-2");
  });

  it("re-copies the file that was in flight at the quit, linked to the new paste", async () => {
    // After a restart the file in flight has no paused row of its own (the
    // backend drops it, #3643): its partial destination is shorter than the
    // source, so the Retry copies it again as part of the folder.
    vi.mocked(getAllTabsAcrossGroupTrees).mockReturnValue([tab("web-2", "conn-web")]);
    vi.mocked(localListDir).mockResolvedValue([
      entry("done.bin", "/home/u/proj/done.bin", 50),
      entry("in-flight.bin", "/home/u/proj/in-flight.bin", 50),
      entry("todo.bin", "/home/u/proj/todo.bin", 50),
    ]);
    vi.mocked(sessionListFiles).mockResolvedValue([
      entry("done.bin", "/srv/proj/done.bin", 50),
      entry("in-flight.bin", "/srv/proj/in-flight.bin", 20),
    ]);
    const { sessionSupportsTransferQueue } = await import("@/services/api");
    vi.mocked(sessionSupportsTransferQueue).mockResolvedValue(true);
    vi.mocked(sessionUpload).mockImplementation(async (_s, local, _r, onRegistered) => {
      onRegistered?.(`t:${local}`);
      return 50;
    });

    await retryInterruptedFolderPaste(interrupted);

    expect(vi.mocked(sessionUpload).mock.calls.map((c) => c[1])).toEqual([
      "/home/u/proj/in-flight.bin",
      "/home/u/proj/todo.bin",
    ]);
    expect(vi.mocked(folderPasteLinkTransfer).mock.calls).toEqual([
      ["paste-2", "t:/home/u/proj/in-flight.bin"],
      ["paste-2", "t:/home/u/proj/todo.bin"],
    ]);
    expect(vi.mocked(folderPasteEnd)).toHaveBeenCalledWith("paste-2");
  });
});
