import { describe, it, expect, beforeEach } from "vitest";
import type { FileEntry } from "@/types/connection";
import {
  SELF_DROP_GRACE_MS,
  STAGED_DRAG_OUT_TTL_MS,
  StagedDragOutCache,
  beginDragOut,
  endDragOut,
  isOutsideViewport,
  isOwnDragOut,
  planDragOut,
  resetDragOutTracking,
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

  it("refuses remote folders with a Download hint", () => {
    const plan = planDragOut(
      [entry("/srv/a.txt"), entry("/srv/logs", { isDirectory: true })],
      sftp
    );
    expect(plan.kind).toBe("refuse");
    expect(plan.kind === "refuse" && plan.message).toMatch(/"logs".*download|download.*"logs"/i);
  });

  it("refuses byte-based sessions (no transfer queue to stage through)", () => {
    const plan = planDragOut([entry("/a")], { ...sftp, transferQueueCapable: false });
    expect(plan).toMatchObject({ kind: "refuse", message: expect.stringMatching(/Download/) });
  });

  it("refuses an empty drag, no pane, and a session without an id", () => {
    expect(planDragOut([], { mode: "local" }).kind).toBe("refuse");
    expect(planDragOut([entry("/a")], { mode: "none" }).kind).toBe("refuse");
    expect(planDragOut([entry("/a")], { ...sftp, sessionId: null }).kind).toBe("refuse");
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
