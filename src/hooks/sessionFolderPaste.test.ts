import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/api", () => ({
  folderPasteBegin: vi.fn(() => Promise.resolve("paste-2")),
  folderPasteEnd: vi.fn(() => Promise.resolve()),
  folderPasteLinkTransfer: vi.fn(() => Promise.resolve()),
  localListDir: vi.fn(() => Promise.resolve([])),
  localMkdir: vi.fn(() => Promise.resolve()),
  sessionCopy: vi.fn(() => Promise.resolve()),
  sessionCopyRemote: vi.fn(() => Promise.resolve(0)),
  sessionDeleteFile: vi.fn(() => Promise.resolve()),
  sessionDownload: vi.fn(() => Promise.resolve(0)),
  sessionHasExecCapability: vi.fn(() => Promise.reject(new Error("not sftp-backed"))),
  sessionListFiles: vi.fn(() => Promise.resolve([])),
  sessionMkdir: vi.fn(() => Promise.resolve()),
  sessionReadFile: vi.fn(() => Promise.resolve(new Uint8Array([1]))),
  sessionRenameFile: vi.fn(() => Promise.resolve()),
  sessionSupportsRemoteCopy: vi.fn(() => Promise.resolve(false)),
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
  localMkdir,
  sessionCopyRemote,
  sessionDeleteFile,
  sessionDownload,
  sessionSupportsTransferQueue,
  sessionListFiles,
  sessionMkdir,
  sessionReadFile,
  sessionRenameFile,
  sessionSupportsRemoteCopy,
  sessionUpload,
  sessionWriteFile,
  type InterruptedFolderPaste,
} from "@/services/api";
import { getAllTabsAcrossGroupTrees } from "@/store/layoutSelectors";
import type { FileEntry } from "@/types/connection";
import type { LogEntry, TerminalTab } from "@/types/terminal";
import { onFrontendLog } from "@/utils/frontendLog";
import {
  FolderPasteEndpointUnavailable,
  pasteFileLeg,
  pasteFolderRecorded,
  pasteFolderTree,
  probeRemoteCopy,
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
  srcRemoteCopy: false,
  destRemoteCopy: false,
  destSftp: false,
  destQueueCapable: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllTabsAcrossGroupTrees).mockReturnValue([]);
  vi.mocked(sessionListFiles).mockResolvedValue([]);
});

describe("pasteFileLeg — session-to-session copies (#3586)", () => {
  const streamable: PasteTransport = {
    operation: "copy",
    sourceMode: "session",
    srcSession: "docker-src",
    destSession: "sftp-dst",
    srcRemoteCopy: true,
    destRemoteCopy: true,
    destSftp: true,
    destQueueCapable: true,
  };

  it("streams a Docker-to-SFTP copy as one tracked transfer", async () => {
    await expect(pasteFileLeg(streamable, "/src/a.bin", "/dst/a.bin", false)).resolves.toBe(true);

    expect(vi.mocked(sessionCopyRemote)).toHaveBeenCalledWith(
      "docker-src",
      "/src/a.bin",
      "sftp-dst",
      "/dst/a.bin",
      expect.any(Function)
    );
    expect(vi.mocked(sessionReadFile)).not.toHaveBeenCalled();
    expect(vi.mocked(sessionWriteFile)).not.toHaveBeenCalled();
  });

  it("streams a Docker-to-Docker copy (neither end is SFTP)", async () => {
    await pasteFileLeg(
      { ...streamable, destSession: "docker-dst", destSftp: false },
      "/src/a.bin",
      "/dst/a.bin",
      false
    );

    expect(vi.mocked(sessionCopyRemote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessionReadFile)).not.toHaveBeenCalled();
  });

  it("keeps the byte-based fallback when an end cannot stream (FTP, agent)", async () => {
    await expect(
      pasteFileLeg(
        { ...streamable, destSession: "ftp-dst", destRemoteCopy: false, destSftp: false },
        "/src/a.bin",
        "/dst/a.bin",
        false
      )
    ).resolves.toBe(false);

    expect(vi.mocked(sessionCopyRemote)).not.toHaveBeenCalled();
    expect(vi.mocked(sessionReadFile)).toHaveBeenCalledWith("docker-src", "/src/a.bin");
    expect(vi.mocked(sessionWriteFile)).toHaveBeenCalledWith(
      "ftp-dst",
      "/dst/a.bin",
      expect.any(Uint8Array)
    );
  });
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
    srcRemoteCopy: false,
    destRemoteCopy: true,
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
      { ...uploadTransport, sourceMode: "session", srcSession: "sftp-src", srcRemoteCopy: true },
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

  it("streams a session-to-session retry when both ends can stream", async () => {
    vi.mocked(getAllTabsAcrossGroupTrees).mockReturnValue([
      tab("web-2", "conn-web"),
      tab("box-2", "conn-box"),
    ]);
    vi.mocked(sessionSupportsRemoteCopy).mockResolvedValue(true);
    vi.mocked(sessionListFiles).mockImplementation(async (id) =>
      id === "box-2" ? [entry("a.bin", "/data/a.bin", 5)] : []
    );

    await retryInterruptedFolderPaste({
      ...interrupted,
      source: { sessionId: "gone", connectionId: "conn-box", label: "box", path: "/data" },
    });

    expect(vi.mocked(sessionSupportsRemoteCopy)).toHaveBeenCalledWith("box-2");
    expect(vi.mocked(sessionSupportsRemoteCopy)).toHaveBeenCalledWith("web-2");
    expect(vi.mocked(sessionCopyRemote)).toHaveBeenCalledWith(
      "box-2",
      "/data/a.bin",
      "web-2",
      "/srv/proj/a.bin",
      expect.any(Function)
    );
    expect(vi.mocked(sessionReadFile)).not.toHaveBeenCalled();
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

describe("retryInterruptedFolderPaste — remote → local (#3912)", () => {
  const interrupted: InterruptedFolderPaste = {
    id: "old",
    operation: "copy",
    source: { sessionId: "dead", connectionId: "conn-web", label: "web", path: "/srv/logs" },
    destination: { sessionId: null, connectionId: null, label: "Local", path: "/home/u/logs" },
    startedAtMs: 1,
  };

  beforeEach(() => {
    vi.mocked(sessionSupportsTransferQueue).mockResolvedValue(true);
    vi.mocked(sessionListFiles).mockImplementation(async (_s, path) =>
      path === "/srv/logs"
        ? [entry("a.log", "/srv/logs/a.log", 5), entry("b.log", "/srv/logs/b.log", 5)]
        : []
    );
    vi.mocked(localListDir).mockImplementation(async (path) =>
      path === "/home/u/logs" ? [entry("a.log", "/home/u/logs/a.log", 5)] : []
    );
  });

  it("refuses when the source connection is not open", async () => {
    await expect(retryInterruptedFolderPaste(interrupted)).rejects.toThrow(
      "Connect to web first, then retry."
    );
    expect(vi.mocked(folderPasteBegin)).not.toHaveBeenCalled();
    expect(vi.mocked(sessionDownload)).not.toHaveBeenCalled();
  });

  it("downloads only the missing files over the reconnected session, recorded afresh", async () => {
    vi.mocked(getAllTabsAcrossGroupTrees).mockReturnValue([tab("web-2", "conn-web")]);
    vi.mocked(sessionDownload).mockImplementationOnce(async (_s, _r, _l, onRegistered) => {
      onRegistered?.("xfer-b");
      return 5;
    });

    await retryInterruptedFolderPaste(interrupted);

    expect(vi.mocked(folderPasteBegin)).toHaveBeenCalledWith(
      "copy",
      expect.objectContaining({ sessionId: "web-2", connectionId: "conn-web", path: "/srv/logs" }),
      expect.objectContaining({ sessionId: null, path: "/home/u/logs" })
    );
    expect(vi.mocked(sessionDownload)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessionDownload)).toHaveBeenCalledWith(
      "web-2",
      "/srv/logs/b.log",
      "/home/u/logs/b.log",
      expect.any(Function)
    );
    // The local folder is already there: it is merged into, not recreated.
    expect(vi.mocked(localMkdir)).not.toHaveBeenCalled();
    expect(vi.mocked(folderPasteLinkTransfer)).toHaveBeenCalledWith("paste-2", "xfer-b");
    expect(vi.mocked(folderPasteEnd)).toHaveBeenCalledWith("paste-2");
  });

  it("creates the local folder when it is missing and copies everything", async () => {
    vi.mocked(getAllTabsAcrossGroupTrees).mockReturnValue([tab("web-2", "conn-web")]);
    vi.mocked(localListDir).mockRejectedValue(new Error("No such file or directory"));

    await retryInterruptedFolderPaste(interrupted);

    expect(vi.mocked(localMkdir)).toHaveBeenCalledWith("/home/u/logs");
    expect(vi.mocked(sessionDownload).mock.calls.map((c) => c[1])).toEqual([
      "/srv/logs/a.log",
      "/srv/logs/b.log",
    ]);
  });

  it("finishes a move by removing the remote source once the rest landed", async () => {
    vi.mocked(getAllTabsAcrossGroupTrees).mockReturnValue([tab("web-2", "conn-web")]);

    await retryInterruptedFolderPaste({ ...interrupted, operation: "cut" });

    expect(vi.mocked(sessionDeleteFile)).toHaveBeenCalledWith("web-2", "/srv/logs");
    const download = vi.mocked(sessionDownload).mock.invocationCallOrder[0];
    const del = vi.mocked(sessionDeleteFile).mock.invocationCallOrder[0];
    expect(download).toBeLessThan(del);
  });
});

describe("probeRemoteCopy (#4520)", () => {
  it("a failed probe means no remote copy, and leaves a DEBUG trace", async () => {
    vi.mocked(sessionSupportsRemoteCopy).mockRejectedValueOnce(new Error("session gone"));
    const entries: LogEntry[] = [];
    const unsubscribe = onFrontendLog((e) => entries.push(e));
    await expect(probeRemoteCopy("s1")).resolves.toBe(false);
    unsubscribe();
    const trace = entries.find((e) => e.message.includes("remote-copy support of session s1"));
    expect(trace?.level).toBe("DEBUG");
    expect(trace?.message).toContain("session gone");
  });
});
