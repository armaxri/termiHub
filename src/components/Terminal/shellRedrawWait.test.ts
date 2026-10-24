import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESIZE_REDRAW_QUIET_MS,
  RESIZE_REDRAW_WAIT_MS,
  createShellRedrawWait,
} from "./shellRedrawWait";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shell redraw wait (#4958)", () => {
  it("releases a quiet period after the first output chunk", () => {
    const wait = createShellRedrawWait();
    const release = vi.fn();
    wait.releaseAfterRedraw(release);

    vi.advanceTimersByTime(100);
    expect(release).not.toHaveBeenCalled();

    wait.notifyOutput();
    vi.advanceTimersByTime(RESIZE_REDRAW_QUIET_MS - 1);
    expect(release).not.toHaveBeenCalled();
    // More chunks of the same repaint do not extend the wait.
    wait.notifyOutput();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases after the bound when no output arrives", () => {
    const wait = createShellRedrawWait();
    const release = vi.fn();
    wait.releaseAfterRedraw(release);

    vi.advanceTimersByTime(RESIZE_REDRAW_WAIT_MS - 1);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("ignores output that arrived before the wait started", () => {
    const wait = createShellRedrawWait();
    wait.notifyOutput();
    const release = vi.fn();
    wait.releaseAfterRedraw(release);

    vi.advanceTimersByTime(RESIZE_REDRAW_QUIET_MS + 1);
    expect(release).not.toHaveBeenCalled();
  });

  it("releases each wait exactly once, also on teardown", () => {
    const wait = createShellRedrawWait();
    const first = vi.fn();
    const second = vi.fn();
    wait.releaseAfterRedraw(first);
    wait.releaseAfterRedraw(second);

    wait.releaseAll();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    wait.notifyOutput();
    vi.advanceTimersByTime(RESIZE_REDRAW_WAIT_MS * 2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  describe("waitForInputEcho", () => {
    it("has nothing to wait for without input, or once output answered it", () => {
      const wait = createShellRedrawWait();
      expect(wait.waitForInputEcho(undefined)).toBeNull();

      const inputAt = Date.now();
      vi.advanceTimersByTime(5);
      wait.notifyOutput();
      expect(wait.waitForInputEcho(inputAt)).toBeNull();
    });

    it("has nothing to wait for once the input is older than the bound", () => {
      const wait = createShellRedrawWait();
      const inputAt = Date.now();
      vi.advanceTimersByTime(RESIZE_REDRAW_WAIT_MS);
      expect(wait.waitForInputEcho(inputAt)).toBeNull();
    });

    it("resolves on the echo of unanswered input", async () => {
      const wait = createShellRedrawWait();
      const inputAt = Date.now();
      vi.advanceTimersByTime(1);
      const done = vi.fn();
      void wait.waitForInputEcho(inputAt)?.then(done);
      await Promise.resolve();
      expect(done).not.toHaveBeenCalled();

      wait.notifyOutput();
      await Promise.resolve();
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("resolves at the bound, counted from the input, when no echo comes", async () => {
      const wait = createShellRedrawWait();
      const inputAt = Date.now();
      vi.advanceTimersByTime(100);
      const done = vi.fn();
      void wait.waitForInputEcho(inputAt)?.then(done);

      vi.advanceTimersByTime(RESIZE_REDRAW_WAIT_MS - 101);
      await Promise.resolve();
      expect(done).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      expect(done).toHaveBeenCalledTimes(1);
    });
  });
});
