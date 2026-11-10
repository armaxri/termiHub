import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToastOptions } from "@/components/ui";

const toastSuccess = vi.fn((_message: string, _opts?: ToastOptions) => "t");
vi.mock("@/components/ui", () => ({
  toast: { success: (m: string, o?: ToastOptions) => toastSuccess(m, o) },
}));

import {
  UNDO_WINDOW_MS,
  deferDelete,
  flushPendingDeletes,
  isDeleteUndone,
  showUndoToast,
} from "./undoableDelete";

describe("undoableDelete (#5158)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toastSuccess.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("shows a 10 s success toast whose Undo runs once", () => {
    const onUndo = vi.fn();
    showUndoToast("Deleted x", { onUndo, id: "loading-1", testId: "tid" });
    const opts = toastSuccess.mock.calls[0][1]!;
    expect(opts).toMatchObject({ id: "loading-1", duration: UNDO_WINDOW_MS, testId: "tid" });
    expect(opts.action?.label).toBe("Undo");
    opts.action!.onClick();
    opts.action!.onClick();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("commits a deferred delete only when the undo window ends", async () => {
    const commit = vi.fn(() => Promise.resolve());
    const { promise } = deferDelete(commit);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    await expect(promise).resolves.toBeUndefined();
  });

  it("drops the commit on cancel and rejects with the undone marker", async () => {
    const commit = vi.fn(() => Promise.resolve());
    const deferred = deferDelete(commit);
    expect(deferred.cancel()).toBe(true);
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    expect(commit).not.toHaveBeenCalled();
    const err = await deferred.promise.catch((e: unknown) => e);
    expect(isDeleteUndone(err)).toBe(true);
    expect(deferred.cancel()).toBe(false);
  });

  it("cannot cancel once committed, and passes commit failures on", async () => {
    const deferred = deferDelete(() => Promise.reject(new Error("disk full")));
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(deferred.cancel()).toBe(false);
    await expect(deferred.promise).rejects.toThrow("disk full");
  });

  it("flushes pending deletes at once (window close / app quit)", async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    deferDelete(first);
    const cancelled = deferDelete(second);
    cancelled.cancel();
    cancelled.promise.catch(() => undefined);
    await flushPendingDeletes();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    // Nothing runs twice when the timer later fires.
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(first).toHaveBeenCalledTimes(1);
  });
});
