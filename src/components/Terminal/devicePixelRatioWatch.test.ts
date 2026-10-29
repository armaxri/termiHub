import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { watchDevicePixelRatio } from "./devicePixelRatioWatch";

/** A matchMedia stub whose queries can be fired, like a monitor move does. */
function installMatchMedia() {
  const lists: Array<{ query: string; listeners: Set<() => void> }> = [];
  const original = window.matchMedia;
  window.matchMedia = vi.fn((query: string) => {
    const entry = { query, listeners: new Set<() => void>() };
    lists.push(entry);
    return {
      matches: true,
      media: query,
      addEventListener: (_: string, cb: () => void) => entry.listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => entry.listeners.delete(cb),
    } as unknown as MediaQueryList;
  });
  return {
    lists,
    fireLatest: () => lists[lists.length - 1]?.listeners.forEach((cb) => cb()),
    listenerCount: () => lists.reduce((n, l) => n + l.listeners.size, 0),
    restore: () => {
      window.matchMedia = original;
    },
  };
}

function setDpr(value: number) {
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value });
}

describe("watchDevicePixelRatio (#5065)", () => {
  let media: ReturnType<typeof installMatchMedia>;

  beforeEach(() => {
    setDpr(1);
    media = installMatchMedia();
  });

  afterEach(() => {
    media.restore();
    setDpr(1);
  });

  it("reports a ratio change signalled by the resolution media query", () => {
    const onChange = vi.fn();
    const stop = watchDevicePixelRatio(window, onChange);
    expect(media.lists[0].query).toBe("(resolution: 1dppx)");
    setDpr(1.5);
    media.fireLatest();
    expect(onChange).toHaveBeenCalledWith(1.5);
    // Re-armed for the new ratio, so the next move is seen too.
    expect(media.lists[media.lists.length - 1].query).toBe("(resolution: 1.5dppx)");
    setDpr(1.25);
    media.fireLatest();
    expect(onChange).toHaveBeenLastCalledWith(1.25);
    stop();
  });

  it("reports a ratio change seen on a window resize", () => {
    const onChange = vi.fn();
    const stop = watchDevicePixelRatio(window, onChange);
    setDpr(2);
    window.dispatchEvent(new Event("resize"));
    expect(onChange).toHaveBeenCalledWith(2);
    stop();
  });

  it("stays quiet while the ratio is unchanged", () => {
    const onChange = vi.fn();
    const stop = watchDevicePixelRatio(window, onChange);
    window.dispatchEvent(new Event("resize"));
    media.fireLatest();
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it("reports each change once even when both signals fire", () => {
    const onChange = vi.fn();
    const stop = watchDevicePixelRatio(window, onChange);
    setDpr(1.5);
    media.fireLatest();
    window.dispatchEvent(new Event("resize"));
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("removes every listener when stopped", () => {
    const onChange = vi.fn();
    const stop = watchDevicePixelRatio(window, onChange);
    stop();
    expect(media.listenerCount()).toBe(0);
    setDpr(2);
    window.dispatchEvent(new Event("resize"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("works without matchMedia, from window resizes alone", () => {
    media.restore();
    const original = window.matchMedia;
    // @ts-expect-error -- an engine without matchMedia
    delete window.matchMedia;
    try {
      const onChange = vi.fn();
      const stop = watchDevicePixelRatio(window, onChange);
      setDpr(1.25);
      window.dispatchEvent(new Event("resize"));
      expect(onChange).toHaveBeenCalledWith(1.25);
      stop();
    } finally {
      window.matchMedia = original;
    }
  });
});
