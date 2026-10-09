import { describe, it, expect, vi } from "vitest";
import {
  WebglContextPool,
  createWebglRenderer,
  DEFAULT_WEBGL_CONTEXT_CAPACITY,
  type WebglAddonLike,
  type WebglRendererOptions,
} from "./webglRenderer";

// Regression tests for #4308 (PERF2-004): WebGL contexts are a resource of
// visible terminals only, capped by a shared pool so N tabs can never exhaust
// the WebView's ~16 active-context limit, and a lost context is recoverable.

class FakeAddon implements WebglAddonLike {
  disposed = false;
  private lossCb: (() => void) | null = null;
  dispose = vi.fn(() => {
    this.disposed = true;
  });
  onContextLoss(cb: () => void) {
    this.lossCb = cb;
    return { dispose: vi.fn() };
  }
  loseContext() {
    this.lossCb?.();
  }
}

function makeTerminal(
  id: string,
  pool: WebglContextPool,
  overrides: Partial<WebglRendererOptions> = {}
) {
  const addons: FakeAddon[] = [];
  const changes: Array<{ renderer: string; reason: string }> = [];
  const loadAddon = vi.fn();
  const controller = createWebglRenderer({
    id,
    pool,
    createAddon: () => {
      const a = new FakeAddon();
      addons.push(a);
      return a;
    },
    loadAddon,
    onRendererChange: (renderer, reason) => changes.push({ renderer, reason }),
    ...overrides,
  });
  const live = () => addons.filter((a) => !a.disposed).length;
  return { controller, addons, changes, loadAddon, live };
}

describe("WebglContextPool", () => {
  it("defaults to a capacity well below the engine's 16-context cap", () => {
    expect(DEFAULT_WEBGL_CONTEXT_CAPACITY).toBeGreaterThan(0);
    expect(DEFAULT_WEBGL_CONTEXT_CAPACITY).toBeLessThan(16);
    expect(new WebglContextPool().capacity).toBe(DEFAULT_WEBGL_CONTEXT_CAPACITY);
  });

  it("evicts the least recently acquired holder when full", () => {
    const pool = new WebglContextPool(2);
    const evictA = vi.fn();
    const evictB = vi.fn();
    pool.acquire("a", evictA);
    pool.acquire("b", evictB);
    // Touching "a" makes "b" the least recent.
    pool.acquire("a", evictA);
    pool.acquire("c", vi.fn());
    expect(evictB).toHaveBeenCalledTimes(1);
    expect(evictA).not.toHaveBeenCalled();
    expect(pool.size).toBe(2);
    expect(pool.has("b")).toBe(false);
  });

  it("release frees a slot without evicting anyone", () => {
    const pool = new WebglContextPool(1);
    const evictA = vi.fn();
    pool.acquire("a", evictA);
    pool.release("a");
    pool.acquire("b", vi.fn());
    expect(evictA).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
  });
});

describe("createWebglRenderer", () => {
  it("keeps the number of live contexts bounded with N visible terminals", () => {
    const pool = new WebglContextPool(4);
    const terms = Array.from({ length: 20 }, (_, i) => makeTerminal(`t${i}`, pool));
    terms.forEach((t) => t.controller.setVisible(true));

    const live = terms.reduce((n, t) => n + t.live(), 0);
    expect(live).toBe(4);
    expect(pool.size).toBe(4);
    // The most recently shown terminals hold the contexts; evicted ones are on DOM.
    expect(terms[19].controller.active).toBe(true);
    expect(terms[0].controller.active).toBe(false);
    expect(terms[0].changes.at(-1)).toEqual({ renderer: "dom", reason: "evicted" });
  });

  it("holds no context at all for terminals that are never visible", () => {
    const pool = new WebglContextPool(4);
    const terms = Array.from({ length: 20 }, (_, i) => makeTerminal(`t${i}`, pool));
    terms.forEach((t) => t.controller.setVisible(false));
    expect(terms.reduce((n, t) => n + t.addons.length, 0)).toBe(0);
    expect(pool.size).toBe(0);
  });

  it("releases its context when hidden and reacquires it when shown", () => {
    const pool = new WebglContextPool(4);
    const t = makeTerminal("t", pool);

    t.controller.setVisible(true);
    expect(t.controller.active).toBe(true);
    expect(t.loadAddon).toHaveBeenCalledWith(t.addons[0]);
    expect(t.changes.at(-1)).toEqual({ renderer: "webgl", reason: "visible" });

    t.controller.setVisible(false);
    expect(t.addons[0].dispose).toHaveBeenCalledTimes(1);
    expect(t.controller.active).toBe(false);
    expect(pool.size).toBe(0);
    expect(t.changes.at(-1)).toEqual({ renderer: "dom", reason: "hidden" });

    t.controller.setVisible(true);
    expect(t.addons).toHaveLength(2);
    expect(t.live()).toBe(1);
    expect(t.controller.active).toBe(true);
    expect(pool.size).toBe(1);
  });

  it("is idempotent for repeated visibility updates", () => {
    const pool = new WebglContextPool(4);
    const t = makeTerminal("t", pool);
    t.controller.setVisible(true);
    t.controller.setVisible(true);
    expect(t.addons).toHaveLength(1);
    t.controller.setVisible(false);
    t.controller.setVisible(false);
    expect(t.addons[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("falls back to the DOM renderer on context loss and retries on the next show", () => {
    const pool = new WebglContextPool(4);
    const t = makeTerminal("t", pool);
    t.controller.setVisible(true);

    t.addons[0].loseContext();
    expect(t.addons[0].dispose).toHaveBeenCalledTimes(1);
    expect(t.controller.active).toBe(false);
    expect(pool.size).toBe(0);
    expect(t.changes.at(-1)).toEqual({ renderer: "dom", reason: "context-lost" });

    // Not retried while still visible (no thrash loop on a GPU that keeps losing).
    t.controller.setVisible(true);
    expect(t.addons).toHaveLength(1);

    // A hide → show cycle tries WebGL again: the fallback is no longer permanent.
    t.controller.setVisible(false);
    t.controller.setVisible(true);
    expect(t.addons).toHaveLength(2);
    expect(t.controller.active).toBe(true);
  });

  it("stays on the DOM renderer for good when WebGL cannot be created", () => {
    const pool = new WebglContextPool(4);
    const createAddon = vi.fn(() => {
      throw new Error("WebGL2 unavailable");
    });
    const t = makeTerminal("t", pool, { createAddon });
    t.controller.setVisible(true);
    expect(t.controller.active).toBe(false);
    expect(pool.size).toBe(0);
    expect(t.changes.at(-1)).toEqual({ renderer: "dom", reason: "unavailable" });

    t.controller.setVisible(false);
    t.controller.setVisible(true);
    expect(createAddon).toHaveBeenCalledTimes(1);
  });

  it("releases the pool slot and disposes the addon when loading fails", () => {
    const pool = new WebglContextPool(4);
    const t = makeTerminal("t", pool, {
      loadAddon: () => {
        throw new Error("activate failed");
      },
    });
    t.controller.setVisible(true);
    expect(t.addons[0].dispose).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);
  });

  it("dispose releases the context and ignores later visibility changes", () => {
    const pool = new WebglContextPool(4);
    const t = makeTerminal("t", pool);
    t.controller.setVisible(true);
    t.controller.dispose();
    expect(t.addons[0].dispose).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);
    t.controller.setVisible(true);
    expect(t.addons).toHaveLength(1);
  });
});
