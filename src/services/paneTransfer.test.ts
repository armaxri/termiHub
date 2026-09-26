/**
 * Dual-pane transfer engine (PROD-007, #3558): local ↔ remote copies run
 * through the transfer queue when the session supports it (seeding a queue row
 * per file) and fall back to a byte-based round-trip otherwise; folders are
 * recreated and copied recursively.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileEntry } from "@/types/connection";

const api = vi.hoisted(() => ({
  sessionUpload: vi.fn(),
  sessionDownload: vi.fn(),
  sessionReadFile: vi.fn(),
  sessionWriteFile: vi.fn(),
  sessionMkdir: vi.fn(),
  sessionListFiles: vi.fn(),
  localMkdir: vi.fn(),
  localListDir: vi.fn(),
}));
vi.mock("@/services/api", () => api);

const fs = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => fs);

const feedback = vi.hoisted(() => ({
  seedTransferQueueRow: vi.fn(),
  runMaybeTrackedTransfer: vi.fn(
    async (_label: string, action: () => Promise<boolean>) => {
      try {
        await action();
        return true;
      } catch {
        return false;
      }
    }
  ),
}));
vi.mock("@/hooks/transferFeedback", () => feedback);

import { copyBetweenPanes } from "./paneTransfer";

function file(path: string): FileEntry {
  const name = path.split("/").pop()!;
  return { name, path, isDirectory: false, size: 1, modified: "" } as FileEntry;
}
function dir(path: string): FileEntry {
  return { ...file(path), isDirectory: true };
}

const queued = { sessionId: "s1", queueCapable: true };
const byteBased = { sessionId: "s1", queueCapable: false };

beforeEach(() => {
  vi.clearAllMocks();
  api.sessionUpload.mockImplementation(async (_s, _l, _r, onRegistered) => {
    onRegistered?.("t-up");
    return 1;
  });
  api.sessionDownload.mockImplementation(async (_s, _r, _l, onRegistered) => {
    onRegistered?.("t-down");
    return 1;
  });
});

describe("copyBetweenPanes", () => {
  it("uploads a local file through the transfer queue and seeds its row", async () => {
    const ok = await copyBetweenPanes({
      from: "local",
      entries: [file("/home/me/a.txt")],
      destDir: "/srv",
      remote: queued,
    });
    expect(ok).toBe(true);
    expect(api.sessionUpload).toHaveBeenCalledWith(
      "s1",
      "/home/me/a.txt",
      "/srv/a.txt",
      expect.any(Function)
    );
    expect(feedback.seedTransferQueueRow).toHaveBeenCalledWith({
      transferId: "t-up",
      sessionId: "s1",
      direction: "upload",
      remotePath: "/srv/a.txt",
    });
  });

  it("downloads a remote file through the transfer queue", async () => {
    await copyBetweenPanes({
      from: "remote",
      entries: [file("/srv/b.log")],
      destDir: "C:\\Users\\me",
      remote: queued,
    });
    expect(api.sessionDownload).toHaveBeenCalledWith(
      "s1",
      "/srv/b.log",
      "C:/Users/me/b.log",
      expect.any(Function)
    );
    expect(feedback.seedTransferQueueRow).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "download", remotePath: "/srv/b.log" })
    );
  });

  it("falls back to a byte round-trip when the session has no transfer queue", async () => {
    fs.readFile.mockResolvedValue(new Uint8Array([1]));
    api.sessionReadFile.mockResolvedValue(new Uint8Array([2]));
    await copyBetweenPanes({
      from: "local",
      entries: [file("/l/a")],
      destDir: "/r",
      remote: byteBased,
    });
    expect(api.sessionWriteFile).toHaveBeenCalledWith("s1", "/r/a", new Uint8Array([1]));
    await copyBetweenPanes({
      from: "remote",
      entries: [file("/r/b")],
      destDir: "/l",
      remote: byteBased,
    });
    expect(fs.writeFile).toHaveBeenCalledWith("/l/b", new Uint8Array([2]));
    expect(api.sessionUpload).not.toHaveBeenCalled();
    expect(api.sessionDownload).not.toHaveBeenCalled();
  });

  it("recreates a local folder remotely and copies its tree", async () => {
    api.localListDir.mockImplementation(async (path: string) =>
      path === "/l/proj" ? [file("/l/proj/x"), dir("/l/proj/sub")] : [file("/l/proj/sub/y")]
    );
    await copyBetweenPanes({
      from: "local",
      entries: [dir("/l/proj")],
      destDir: "/r",
      remote: queued,
    });
    expect(api.sessionMkdir.mock.calls.map((c) => c[1])).toEqual(["/r/proj", "/r/proj/sub"]);
    expect(api.sessionUpload.mock.calls.map((c) => c[2])).toEqual([
      "/r/proj/x",
      "/r/proj/sub/y",
    ]);
  });

  it("recreates a remote folder locally and copies its tree", async () => {
    api.sessionListFiles.mockResolvedValue([file("/r/proj/x")]);
    await copyBetweenPanes({
      from: "remote",
      entries: [dir("/r/proj")],
      destDir: "/l",
      remote: queued,
    });
    expect(api.localMkdir).toHaveBeenCalledWith("/l/proj");
    expect(api.sessionDownload.mock.calls.map((c) => c[2])).toEqual(["/l/proj/x"]);
  });

  it("merges into a folder that already exists at the destination", async () => {
    api.sessionMkdir.mockRejectedValue(new Error("exists"));
    api.sessionListFiles.mockResolvedValue([]);
    api.localListDir.mockResolvedValue([file("/l/proj/x")]);
    const ok = await copyBetweenPanes({
      from: "local",
      entries: [dir("/l/proj")],
      destDir: "/r",
      remote: queued,
    });
    expect(ok).toBe(true);
    expect(api.sessionUpload).toHaveBeenCalledTimes(1);
  });

  it("stops at the first failed entry and reports failure", async () => {
    api.sessionUpload.mockRejectedValueOnce(new Error("denied"));
    const ok = await copyBetweenPanes({
      from: "local",
      entries: [file("/l/a"), file("/l/b")],
      destDir: "/r",
      remote: queued,
    });
    expect(ok).toBe(false);
    expect(api.sessionUpload).toHaveBeenCalledTimes(1);
  });
});
