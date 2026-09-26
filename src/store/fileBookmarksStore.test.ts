/**
 * File-browser bookmarks UI store (PROD-007, #3558): the cache stays in step
 * with the backend-owned store on load / add / rename / remove.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileBookmark } from "@/types/fileBookmark";

const api = vi.hoisted(() => ({
  listFileBookmarks: vi.fn(),
  addFileBookmark: vi.fn(),
  renameFileBookmark: vi.fn(),
  removeFileBookmark: vi.fn(),
}));
vi.mock("@/services/fileBookmarksApi", () => api);
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { useFileBookmarksStore, bookmarksForScope } from "./fileBookmarksStore";

function bookmark(id: string, scope = "local", path = `/${id}`): FileBookmark {
  return { id, scope, path, name: id, createdAt: "2026-09-26T00:00:00Z" };
}

beforeEach(() => {
  vi.clearAllMocks();
  useFileBookmarksStore.setState({ bookmarks: [], loaded: false });
});

describe("fileBookmarksStore", () => {
  it("loads every bookmark from the backend", async () => {
    api.listFileBookmarks.mockResolvedValue([bookmark("a"), bookmark("b")]);
    await useFileBookmarksStore.getState().load();
    const state = useFileBookmarksStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.bookmarks.map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("marks the store loaded even when the backend fails", async () => {
    api.listFileBookmarks.mockRejectedValue(new Error("boom"));
    await useFileBookmarksStore.getState().load();
    expect(useFileBookmarksStore.getState().loaded).toBe(true);
  });

  it("adds through the backend and caches the stored bookmark", async () => {
    api.addFileBookmark.mockResolvedValue(bookmark("new", "connection:c1", "/srv"));
    const added = await useFileBookmarksStore.getState().add("connection:c1", "/srv");
    expect(api.addFileBookmark).toHaveBeenCalledWith("connection:c1", "/srv", undefined);
    expect(added.id).toBe("new");
    expect(useFileBookmarksStore.getState().bookmarks.map((b) => b.id)).toEqual(["new"]);
  });

  it("does not duplicate a bookmark the backend returned as already present", async () => {
    useFileBookmarksStore.setState({ bookmarks: [bookmark("a")] });
    api.addFileBookmark.mockResolvedValue(bookmark("a"));
    await useFileBookmarksStore.getState().add("local", "/a");
    expect(useFileBookmarksStore.getState().bookmarks).toHaveLength(1);
  });

  it("renames in place with the backend's stored name", async () => {
    useFileBookmarksStore.setState({ bookmarks: [bookmark("a"), bookmark("b")] });
    api.renameFileBookmark.mockResolvedValue({ ...bookmark("a"), name: "Logs" });
    await useFileBookmarksStore.getState().rename("a", " Logs ");
    expect(api.renameFileBookmark).toHaveBeenCalledWith("a", " Logs ");
    expect(useFileBookmarksStore.getState().bookmarks.map((b) => b.name)).toEqual(["Logs", "b"]);
  });

  it("removes from the cache after the backend confirms", async () => {
    useFileBookmarksStore.setState({ bookmarks: [bookmark("a"), bookmark("b")] });
    api.removeFileBookmark.mockResolvedValue(undefined);
    await useFileBookmarksStore.getState().remove("a");
    expect(useFileBookmarksStore.getState().bookmarks.map((b) => b.id)).toEqual(["b"]);
  });

  it("keeps the cache and rejects when a mutation fails", async () => {
    useFileBookmarksStore.setState({ bookmarks: [bookmark("a")] });
    api.removeFileBookmark.mockRejectedValue(new Error("disk full"));
    await expect(useFileBookmarksStore.getState().remove("a")).rejects.toThrow("disk full");
    expect(useFileBookmarksStore.getState().bookmarks).toHaveLength(1);
  });

  it("bookmarksForScope filters to one connection scope", () => {
    const all = [bookmark("a", "local"), bookmark("b", "connection:c1"), bookmark("c", "local")];
    expect(bookmarksForScope(all, "local").map((b) => b.id)).toEqual(["a", "c"]);
    expect(bookmarksForScope(all, null)).toEqual([]);
  });
});
