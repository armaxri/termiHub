/**
 * WebGL renderer lifecycle for terminals (#4308, audit PERF2-004).
 *
 * Browser engines cap active WebGL contexts per page — 16 in both WebKit
 * (WKWebView / WebKitGTK) and Chromium (WebView2). Creating one more makes the
 * engine force-lose the oldest. A terminal hub keeps every tab's xterm mounted
 * (parked), so giving each one a permanent WebGL2 context meant that past ~16
 * tabs the oldest terminals silently dropped to the DOM renderer for good.
 *
 * This module makes the WebGL context a resource of *visible* terminals:
 *  - a terminal acquires a context when it becomes visible and releases it
 *    when it is hidden (xterm falls back to its DOM renderer while parked);
 *  - a shared {@link WebglContextPool} caps the number of live contexts and
 *    evicts the least recently shown holder, so even many simultaneously
 *    "visible" terminals (split panes, saved panels of other tab groups) stay
 *    under the engine cap. An evicted terminal that stays on screen gets the
 *    next freed slot back (most recently shown first), so no on-screen
 *    terminal stays on the DOM renderer while a slot is free;
 *  - a context loss falls back to the DOM renderer and is retried on the next
 *    hide → show cycle instead of being permanent. It is deliberately not
 *    retried while the terminal stays visible, so a GPU that keeps losing
 *    contexts cannot drive a re-create loop.
 *  - if WebGL cannot be created at all (no WebGL2 in the WebView), the terminal
 *    stays on the DOM renderer and never retries.
 */

import { errorMessage } from "@/utils/errorMessage";

/** The subset of `@xterm/addon-webgl`'s `WebglAddon` this module drives. */
export interface WebglAddonLike {
  onContextLoss(listener: () => void): unknown;
  dispose(): void;
}

export type TerminalRendererKind = "webgl" | "dom";

/** Why the renderer changed — surfaced to the host for logging and re-fit. */
export type RendererChangeReason =
  | "visible"
  | "hidden"
  | "evicted"
  | "reacquired"
  | "context-lost"
  | "unavailable"
  | "disposed";

/**
 * Live-context budget shared by all terminals of a window. Kept well below the
 * engine's 16 so other WebGL users and engine-internal contexts keep headroom.
 */
export const DEFAULT_WEBGL_CONTEXT_CAPACITY = 12;

interface PoolHolder {
  evict: () => void;
  onSlotFree?: () => void;
  seq: number;
}

interface PoolWaiter {
  onSlotFree: () => void;
  seq: number;
}

/**
 * Least-recently-acquired pool of WebGL context holders. Holders are keyed by
 * id; acquiring when full evicts the least recent other holder through the
 * callback it registered.
 *
 * A holder that registered `onSlotFree` is still on screen when evicted, so it
 * joins a wait queue (#4427). When a holder later releases its slot (hidden,
 * closed, context lost), the most recently shown waiter gets exactly that one
 * slot back through `onSlotFree`. Waiters are only ever served from a free
 * slot — never by evicting someone — so visible terminals cannot thrash.
 */
export class WebglContextPool {
  // Map iteration order is insertion order: the first entry is the least recent.
  private readonly holders = new Map<string, PoolHolder>();
  private readonly waiters = new Map<string, PoolWaiter>();
  private seq = 0;
  private draining = false;

  constructor(readonly capacity: number = DEFAULT_WEBGL_CONTEXT_CAPACITY) {}

  get size(): number {
    return this.holders.size;
  }

  has(id: string): boolean {
    return this.holders.has(id);
  }

  /**
   * Claim (or refresh) a slot for `id`, evicting the least recent holder if
   * full. An evicted holder with an `onSlotFree` callback waits for a free slot.
   */
  acquire(id: string, evict: () => void, onSlotFree?: () => void): void {
    this.holders.delete(id);
    this.waiters.delete(id);
    while (this.holders.size >= this.capacity) {
      const oldest = this.holders.entries().next();
      if (oldest.done) break;
      const [oldestId, holder] = oldest.value;
      this.holders.delete(oldestId);
      holder.evict();
      if (holder.onSlotFree) {
        this.waiters.set(oldestId, { onSlotFree: holder.onSlotFree, seq: holder.seq });
      }
    }
    this.holders.set(id, { evict, onSlotFree, seq: ++this.seq });
  }

  /**
   * Give up `id`'s slot and its place in the wait queue. A freed slot goes to
   * the most recently shown waiter.
   */
  release(id: string): void {
    this.waiters.delete(id);
    if (this.holders.delete(id)) this.drain();
  }

  private drain(): void {
    // A waiter re-acquiring may itself release (failed load) — the outer loop
    // keeps serving, so re-entrant calls only need to return.
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.holders.size < this.capacity && this.waiters.size > 0) {
        let nextId: string | null = null;
        let next: PoolWaiter | null = null;
        for (const [waiterId, waiter] of this.waiters) {
          if (!next || waiter.seq > next.seq) {
            nextId = waiterId;
            next = waiter;
          }
        }
        if (nextId === null || next === null) break;
        this.waiters.delete(nextId);
        next.onSlotFree();
      }
    } finally {
      this.draining = false;
    }
  }
}

/** The window-wide pool every terminal shares. */
export const sharedWebglContextPool = new WebglContextPool();

export interface WebglRendererOptions {
  /** Unique id of the terminal (its tab id). */
  id: string;
  /** Creates a fresh WebGL addon; may throw when WebGL2 is unavailable. */
  createAddon: () => WebglAddonLike;
  /** Activates the addon on the terminal (`xterm.loadAddon`); may throw. */
  loadAddon: (addon: WebglAddonLike) => void;
  /** Called whenever the active renderer changes. */
  onRendererChange: (renderer: TerminalRendererKind, reason: RendererChangeReason) => void;
  /** Diagnostic sink for failures. */
  log?: (message: string) => void;
  pool?: WebglContextPool;
}

export interface WebglRendererController {
  /** Whether WebGL currently drives the terminal. */
  readonly active: boolean;
  /** Acquire (visible) or release (hidden) the WebGL context. Idempotent. */
  setVisible(visible: boolean): void;
  /** Release the context for good; later calls are no-ops. */
  dispose(): void;
}

export function createWebglRenderer(options: WebglRendererOptions): WebglRendererController {
  const { id, createAddon, loadAddon, onRendererChange, log } = options;
  const pool = options.pool ?? sharedWebglContextPool;

  let addon: WebglAddonLike | null = null;
  let visible = false;
  let disposed = false;
  // WebGL2 could not be created at all — never retry for this terminal.
  let unavailable = false;
  // The context was lost while visible; retry only after the next hide → show.
  let lostWhileVisible = false;

  const detach = (reason: RendererChangeReason): void => {
    const current = addon;
    if (!current) return;
    addon = null;
    pool.release(id);
    try {
      current.dispose();
    } catch (err) {
      log?.(`webgl addon dispose failed tab=${id}: ${errorMessage(err)}`);
    }
    onRendererChange("dom", reason);
  };

  const attach = (reason: RendererChangeReason = "visible"): void => {
    if (addon || unavailable || lostWhileVisible || disposed) return;
    let created: WebglAddonLike;
    try {
      created = createAddon();
    } catch (err) {
      unavailable = true;
      log?.(`webgl renderer unavailable tab=${id}, using DOM renderer: ${errorMessage(err)}`);
      onRendererChange("dom", "unavailable");
      return;
    }
    pool.acquire(
      id,
      () => detach("evicted"),
      // Evicted while still on screen: take the next free slot back (#4427).
      () => {
        if (visible && !disposed) attach("reacquired");
      }
    );
    created.onContextLoss(() => {
      if (addon !== created) return;
      lostWhileVisible = visible;
      log?.(`webgl context lost tab=${id}; falling back to DOM renderer`);
      detach("context-lost");
    });
    try {
      loadAddon(created);
    } catch (err) {
      pool.release(id);
      try {
        created.dispose();
      } catch {
        // A half-initialised addon may throw on dispose. The load failure that
        // got us here is logged just below; a second line adds nothing.
      }
      unavailable = true;
      log?.(`webgl renderer unavailable tab=${id}, using DOM renderer: ${errorMessage(err)}`);
      onRendererChange("dom", "unavailable");
      return;
    }
    addon = created;
    onRendererChange("webgl", reason);
  };

  return {
    get active() {
      return addon !== null;
    },
    setVisible(next: boolean) {
      if (disposed) return;
      // Already visible: an evicted terminal waits for a free slot instead of
      // evicting another visible one, so repeated updates cannot thrash.
      if (next && visible) return;
      visible = next;
      if (next) {
        attach();
      } else {
        lostWhileVisible = false;
        detach("hidden");
        // Leave the wait queue: a hidden terminal never re-acquires.
        pool.release(id);
      }
    },
    dispose() {
      if (disposed) return;
      detach("disposed");
      disposed = true;
      pool.release(id);
    },
  };
}
