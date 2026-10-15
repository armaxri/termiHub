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

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
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
    expect(last(terms[0].changes)).toEqual({ renderer: "dom", reason: "evicted" });
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
    expect(last(t.changes)).toEqual({ renderer: "webgl", reason: "visible" });

    t.controller.setVisible(false);
    expect(t.addons[0].dispose).toHaveBeenCalledTimes(1);
    expect(t.controller.active).toBe(false);
    expect(pool.size).toBe(0);
    expect(last(t.changes)).toEqual({ renderer: "dom", reason: "hidden" });

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
    expect(last(t.changes)).toEqual({ renderer: "dom", reason: "context-lost" });

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
    expect(last(t.changes)).toEqual({ renderer: "dom", reason: "unavailable" });

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

// #4427: an evicted terminal that stays on screen gets WebGL back as soon as a
// pool slot frees, instead of staying on the DOM renderer until a hide → show.
describe("re-leasing freed slots to evicted on-screen terminals", () => {
  const CAP = DEFAULT_WEBGL_CONTEXT_CAPACITY;

  function showAll(count: number, pool: WebglContextPool) {
    const terms = Array.from({ length: count }, (_, i) => makeTerminal(`t${i}`, pool));
    terms.forEach((t) => t.controller.setVisible(true));
    return terms;
  }

  it("gives a freed slot back to the evicted terminal when another is hidden", () => {
    const pool = new WebglContextPool();
    const terms = showAll(CAP + 1, pool);
    expect(terms[0].controller.active).toBe(false);
    expect(pool.size).toBe(CAP);

    terms[5].controller.setVisible(false);

    expect(terms[0].controller.active).toBe(true);
    expect(last(terms[0].changes)).toEqual({ renderer: "webgl", reason: "reacquired" });
    expect(terms[0].addons).toHaveLength(2);
    expect(pool.size).toBe(CAP);
    // Nobody else was evicted to make room.
    expect(terms.filter((t) => t.controller.active)).toHaveLength(CAP);
    expect(terms[5].controller.active).toBe(false);
  });

  it("serves the most recently shown waiter first, one per freed slot", () => {
    const pool = new WebglContextPool(2);
    const [a, b, c, d] = showAll(4, pool);
    // a then b were evicted; b was shown more recently.
    expect(a.controller.active).toBe(false);
    expect(b.controller.active).toBe(false);

    c.controller.setVisible(false);
    expect(b.controller.active).toBe(true);
    expect(a.controller.active).toBe(false);
    expect(a.addons).toHaveLength(1);

    d.controller.dispose();
    expect(a.controller.active).toBe(true);
    expect(pool.size).toBe(2);
  });

  it("drops a closed waiter from the queue", () => {
    const pool = new WebglContextPool(2);
    const [a, b, c] = showAll(3, pool);
    expect(a.controller.active).toBe(false);

    a.controller.dispose();
    b.controller.setVisible(false);

    expect(a.addons).toHaveLength(1);
    expect(a.controller.active).toBe(false);
    expect(c.controller.active).toBe(true);
    expect(pool.size).toBe(1);
  });

  it("does not re-acquire for a waiter that was hidden", () => {
    const pool = new WebglContextPool(2);
    const [a, b] = showAll(3, pool);
    a.controller.setVisible(false);
    b.controller.setVisible(false);
    expect(a.addons).toHaveLength(1);
    expect(a.controller.active).toBe(false);
    expect(pool.size).toBe(1);

    // Shown again, it acquires normally.
    a.controller.setVisible(true);
    expect(a.controller.active).toBe(true);
  });

  it("hands a slot freed by a lost context to a waiter, not back to the lost terminal", () => {
    const pool = new WebglContextPool(2);
    const [a, b, c] = showAll(3, pool);
    c.addons[0].loseContext();
    expect(last(c.changes)).toEqual({ renderer: "dom", reason: "context-lost" });
    expect(a.controller.active).toBe(true);
    expect(b.controller.active).toBe(true);
    expect(c.addons).toHaveLength(1);
    // The lost terminal is retried only on its next show (#4308 / #4426).
    c.controller.setVisible(false);
    c.controller.setVisible(true);
    expect(c.controller.active).toBe(true);
  });

  it("never thrashes: repeated visible updates from a waiter evict nobody", () => {
    const pool = new WebglContextPool(2);
    const [a, b, c] = showAll(3, pool);
    a.controller.setVisible(true);
    a.controller.setVisible(true);
    expect(a.controller.active).toBe(false);
    expect(b.controller.active).toBe(true);
    expect(c.controller.active).toBe(true);
    expect(b.addons).toHaveLength(1);
    expect(c.addons).toHaveLength(1);
  });

  it("moves on to the next waiter when a re-acquire fails to load", () => {
    const pool = new WebglContextPool(2);
    let failB = false;
    const a = makeTerminal("a", pool);
    const b = makeTerminal("b", pool, {
      loadAddon: () => {
        if (failB) throw new Error("activate failed");
      },
    });
    const c = makeTerminal("c", pool);
    const d = makeTerminal("d", pool);
    [a, b, c, d].forEach((t) => t.controller.setVisible(true));
    failB = true;

    c.controller.setVisible(false);
    expect(b.controller.active).toBe(false);
    expect(a.controller.active).toBe(true);
    expect(pool.size).toBe(2);
  });
});
