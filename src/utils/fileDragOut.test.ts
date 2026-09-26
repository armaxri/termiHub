import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FileEntry } from "@/types/connection";
import {
  DragOutLimitError,
  SELF_DROP_GRACE_MS,
  STAGED_DRAG_OUT_TTL_MS,
  StagedDragOutCache,
  beginDragOut,
  endDragOut,
  isOutsideViewport,
  isOwnDragOut,
  buildStagingTree,
  planDragOut,
  resetDragOutTracking,
  runBounded,
  stagedEntryKey,
} from "./fileDragOut";

function entry(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    isDirectory: false,
    size: 10,
    modified: "2026-09-01T00:00:00Z",
    permissions: null,
    writable: null,
    ...overrides,
  };
}

const sftp = { mode: "session", sessionId: "s1", transferQueueCapable: true } as const;

describe("planDragOut", () => {
  it("hands local files and folders over by their real paths", () => {
    const plan = planDragOut([entry("/a.txt"), entry("/dir", { isDirectory: true })], {
      mode: "local",
    });
    expect(plan).toEqual({ kind: "local", paths: ["/a.txt", "/dir"] });
  });

  it("stages remote files on a queue-capable session", () => {
    const files = [entry("/srv/a.txt"), entry("/srv/b.bin")];
    expect(planDragOut(files, sftp)).toEqual({ kind: "remote", sessionId: "s1", entries: files });
  });

  it("stages remote folders on a queue-capable session too", () => {
    const rows = [entry("/srv/a.txt"), entry("/srv/logs", { isDirectory: true })];
    expect(planDragOut(rows, sftp)).toEqual({ kind: "remote", sessionId: "s1", entries: rows });
  });

  it("hands byte-based sessions (Docker / agent) to backend staging, folders included", () => {
    const rows = [entry("/a"), entry("/d", { isDirectory: true })];
    expect(planDragOut(rows, { ...sftp, transferQueueCapable: false })).toEqual({
      kind: "sessionBytes",
      sessionId: "s1",
      entries: rows,
    });
  });

  it("refuses an empty drag, no pane, and a session without an id", () => {
    expect(planDragOut([], { mode: "local" }).kind).toBe("refuse");
    expect(planDragOut([entry("/a")], { mode: "none" }).kind).toBe("refuse");
    expect(planDragOut([entry("/a")], { ...sftp, sessionId: null }).kind).toBe("refuse");
  });
});

describe("buildStagingTree", () => {
  const dir = (path: string) => entry(path, { isDirectory: true, size: 0 });
  const listing: Record<string, FileEntry[]> = {
    "/srv/logs": [
      entry("/srv/logs/.", { name: ".", isDirectory: true }),
      entry("/srv/logs/a.log", { size: 5 }),
      dir("/srv/logs/sub"),
      entry("/srv/logs/loop", { isDirectory: true, isSymlink: true }),
    ],
    "/srv/logs/sub": [entry("/srv/logs/sub/b.log", { size: 7 })],
    "/srv/empty": [],
  };
  const list = async (path: string) => listing[path] ?? [];

  it("lays out dragged files and folders recursively, parents first", async () => {
    const tree = await buildStagingTree(
      [entry("/srv/top.txt"), dir("/srv/logs"), dir("/srv/empty")],
      list
    );
    expect(tree.staging).toEqual([
      { segments: ["top.txt"], isDirectory: false },
      { segments: ["logs"], isDirectory: true },
      { segments: ["logs", "a.log"], isDirectory: false },
      { segments: ["logs", "sub"], isDirectory: true },
      { segments: ["logs", "sub", "b.log"], isDirectory: false },
      { segments: ["empty"], isDirectory: true },
    ]);
    expect(tree.roots).toEqual([0, 1, 5]);
    expect(tree.downloads).toEqual([
      { index: 0, remotePath: "/srv/top.txt" },
      { index: 2, remotePath: "/srv/logs/a.log" },
      { index: 4, remotePath: "/srv/logs/sub/b.log" },
    ]);
  });

  it("never lists a plain file", async () => {
    const lister = vi.fn(list);
    await buildStagingTree([entry("/srv/a.txt")], lister);
    expect(lister).not.toHaveBeenCalled();
  });

  it("refuses a selection beyond the entry, depth or byte limits", async () => {
    const limits = { maxEntries: 100, maxDepth: 5, maxBytes: 1000 };
    await expect(
      buildStagingTree([dir("/srv/logs")], list, { ...limits, maxEntries: 3 })
    ).rejects.toBeInstanceOf(DragOutLimitError);
    await expect(
      buildStagingTree([dir("/srv/logs")], list, { ...limits, maxDepth: 1 })
    ).rejects.toThrow(/deeper/);
    await expect(
      buildStagingTree([dir("/srv/logs")], list, { ...limits, maxBytes: 10 })
    ).rejects.toThrow(/Download/);
    await expect(buildStagingTree([dir("/srv/logs")], list, limits)).resolves.toBeDefined();
  });
});

describe("runBounded", () => {
  it("never exceeds the concurrency limit and runs every item", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await runBounded([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      done.push(n);
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("stops starting new items after a failure and rethrows it once started ones settle", async () => {
    const started: number[] = [];
    let settled = 0;
    const run = runBounded([1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      await new Promise((r) => setTimeout(r, n === 1 ? 1 : 5));
      settled++;
      if (n === 1) throw new Error("boom");
    });
    await expect(run).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
    expect(settled).toBe(2);
  });

  it("is a no-op for no items", async () => {
    const task = vi.fn();
    await runBounded([], 4, task);
    expect(task).not.toHaveBeenCalled();
  });
});

describe("isOutsideViewport", () => {
  it("is false inside and on the top-left edge", () => {
    expect(isOutsideViewport(0, 0, 800, 600)).toBe(false);
    expect(isOutsideViewport(799, 599, 800, 600)).toBe(false);
  });

  it("is true past any edge", () => {
    expect(isOutsideViewport(-1, 10, 800, 600)).toBe(true);
    expect(isOutsideViewport(10, -1, 800, 600)).toBe(true);
    expect(isOutsideViewport(800, 10, 800, 600)).toBe(true);
    expect(isOutsideViewport(10, 600, 800, 600)).toBe(true);
  });
});

describe("StagedDragOutCache", () => {
  const a = entry("/srv/a.txt");
  const b = entry("/srv/b.txt");

  it("returns the staged copies for fresh, fully staged entries", () => {
    const cache = new StagedDragOutCache();
    cache.add("s1", [a, b], "/stage/1", ["/stage/1/a.txt", "/stage/1/b.txt"], 0);
    expect(cache.lookup("s1", [b, a], 1000)).toEqual(["/stage/1/b.txt", "/stage/1/a.txt"]);
  });

  it("misses when any entry is unstaged, changed, from another session, or expired", () => {
    const cache = new StagedDragOutCache();
    cache.add("s1", [a], "/stage/1", ["/stage/1/a.txt"], 0);
    expect(cache.lookup("s1", [a, b], 1)).toBeNull();
    expect(cache.lookup("s1", [{ ...a, size: 11 }], 1)).toBeNull();
    expect(cache.lookup("s1", [{ ...a, modified: "later" }], 1)).toBeNull();
    expect(cache.lookup("s2", [a], 1)).toBeNull();
    expect(cache.lookup("s1", [a], STAGED_DRAG_OUT_TTL_MS)).toBeNull();
  });

  it("combines entries staged in separate sets", () => {
    const cache = new StagedDragOutCache();
    cache.add("s1", [a], "/stage/1", ["/stage/1/a.txt"], 0);
    cache.add("s1", [b], "/stage/2", ["/stage/2/b.txt"], 0);
    expect(cache.lookup("s1", [a, b], 1)).toEqual(["/stage/1/a.txt", "/stage/2/b.txt"]);
  });

  it("takes expired directories out, keeping fresh ones", () => {
    const cache = new StagedDragOutCache();
    cache.add("s1", [a], "/stage/old", ["/stage/old/a.txt"], 0);
    cache.add("s1", [b], "/stage/new", ["/stage/new/b.txt"], 5000);
    expect(cache.takeExpired(STAGED_DRAG_OUT_TTL_MS)).toEqual(["/stage/old"]);
    expect(cache.size).toBe(1);
    expect(cache.takeAll()).toEqual(["/stage/new"]);
    expect(cache.size).toBe(0);
  });

  it("keys entries by session, path, size and mtime", () => {
    expect(stagedEntryKey("s1", a)).not.toBe(stagedEntryKey("s1", { ...a, size: 99 }));
    expect(stagedEntryKey("s1", a)).not.toBe(stagedEntryKey("s2", a));
  });
});

describe("own drag-out tracking", () => {
  beforeEach(() => resetDragOutTracking());

  it("recognises the dragged paths while the drag is live", () => {
    beginDragOut(["/home/u/a.txt", "/home/u/b.txt"]);
    expect(isOwnDragOut(["/home/u/a.txt"], 0)).toBe(true);
    expect(isOwnDragOut(["/home/u/a.txt", "/home/u/b.txt"], 0)).toBe(true);
    expect(isOwnDragOut(["/home/u/a.txt", "/elsewhere.txt"], 0)).toBe(false);
    expect(isOwnDragOut([], 0)).toBe(false);
  });

  it("matches regardless of path separators", () => {
    beginDragOut(["C:/Users/u/a.txt"]);
    expect(isOwnDragOut(["C:\\Users\\u\\a.txt"], 0)).toBe(true);
  });

  it("keeps ignoring its own drop briefly after the drag ends, then forgets", () => {
    beginDragOut(["/a"]);
    endDragOut(1000);
    expect(isOwnDragOut(["/a"], 1000 + SELF_DROP_GRACE_MS)).toBe(true);
    expect(isOwnDragOut(["/a"], 1001 + SELF_DROP_GRACE_MS)).toBe(false);
  });

  it("never claims a drop when no drag-out happened", () => {
    expect(isOwnDragOut(["/a"], 0)).toBe(false);
  });
});
