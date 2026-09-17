import { vi, type Mock } from "vitest";

/**
 * Shared test double for `@xterm/xterm`'s `Terminal` (MOCK-003).
 *
 * Every `Terminal` component test needs to mock `@xterm/xterm` — jsdom has no
 * real renderer, and the component drives dozens of xterm methods on mount. Each
 * suite used to hand-roll its own `MockXTerm` inside a `vi.mock("@xterm/xterm")`
 * factory; those ~16 copies drifted into slightly different subsets of the xterm
 * surface and, critically, every one of them **omitted `_core`** — the private
 * handle real xterm exposes and that `xtermDimensions.ts` reads
 * (`_core._renderService.dimensions.css.cell.width`) for horizontal-scroll math.
 *
 * This module is the single canonical fake. It is a **superset** of every former
 * copy (so no suite loses behaviour it relied on) and it **includes `_core`** in
 * a minimally faithful shape. The default cell width is `0`, matching an
 * unmeasured xterm under jsdom: `getRenderedCellWidth()` returns `undefined` for
 * a `0` width exactly as it did when `_core` was entirely absent, so adding the
 * handle keeps existing behaviour while making the private shape available.
 *
 * ## Usage
 *
 * Because `vi.mock` is hoisted above imports, pull the class in through the
 * factory's own (async) dynamic import rather than a top-level import:
 *
 * ```ts
 * vi.mock("@xterm/xterm", async () => {
 *   const { createMockXtermModule } = await import("@/test/mockXterm");
 *   return createMockXtermModule();
 * });
 * ```
 *
 * A suite that needs the constructed instances (e.g. to read `options` or a
 * per-instance `write` spy) imports {@link mockXtermInstances} and clears it in
 * `beforeEach` with {@link resetMockXtermInstances}. A suite that needs bespoke
 * capturing behaviour (grabbing an `onScroll`/`onResize`/`write` callback into a
 * file-local variable) extends {@link MockXTerm} inside its own factory and
 * overrides just the handful of members it customises.
 */

/** The active-buffer node the component reads for scroll position and length. */
export interface MockXtermActiveBuffer {
  viewportY: number;
  baseY: number;
  length: number;
  getLine: Mock;
}

/** Minimal `Terminal.buffer` shape (only the `active` buffer is modelled). */
export interface MockXtermBuffer {
  active: MockXtermActiveBuffer;
}

/**
 * Minimal faithful stand-in for xterm's PRIVATE `_core` handle — just the render
 * service path `xtermDimensions.ts` drills through
 * (`_core._renderService.dimensions.css.cell.width`).
 */
export interface MockXtermCore {
  _renderService: {
    dimensions: { css: { cell: { width: number; height: number } } };
  };
}

/** Options bag the component passes to `new Terminal(options)`. */
export type MockXtermOptions = Record<string, unknown>;

/**
 * Canonical fake `Terminal`. Every spy is a `vi.fn()` so suites can assert exact
 * calls. Field initialisers give each instance its own spies (no shared mutable
 * state between instances). Extend this class in a suite's own `vi.mock` factory
 * to layer capturing behaviour without re-declaring the whole surface.
 */
export class MockXTerm {
  open: Mock = vi.fn();
  dispose: Mock = vi.fn();
  loadAddon: Mock = vi.fn();
  onData: Mock = vi.fn(() => ({ dispose: vi.fn() }));
  onResize: Mock = vi.fn(() => ({ dispose: vi.fn() }));
  onScroll: Mock = vi.fn(() => ({ dispose: vi.fn() }));
  onCursorMove: Mock = vi.fn(() => ({ dispose: vi.fn() }));
  onWriteParsed: Mock = vi.fn(() => ({ dispose: vi.fn() }));
  write: Mock = vi.fn((_data: unknown, cb?: () => void) => cb?.());
  writeln: Mock = vi.fn();
  reset: Mock = vi.fn();
  refresh: Mock = vi.fn();
  scrollToBottom: Mock = vi.fn();
  scrollToLine: Mock = vi.fn();
  scrollLines: Mock = vi.fn();
  selectAll: Mock = vi.fn();
  clearSelection: Mock = vi.fn();
  clear: Mock = vi.fn();
  hasSelection: Mock = vi.fn(() => false);
  getSelection: Mock = vi.fn(() => "");
  attachCustomKeyEventHandler: Mock = vi.fn();
  focus: Mock = vi.fn();
  resize: Mock = vi.fn();
  unicode = { activeVersion: "6" };
  modes = { bracketedPasteMode: false };
  cols = 80;
  rows = 24;
  element: HTMLDivElement = document.createElement("div");
  buffer: MockXtermBuffer = {
    active: { viewportY: 0, baseY: 0, length: 0, getLine: vi.fn() },
  };
  parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
  options: MockXtermOptions;
  /**
   * Private `_core` render-service handle. Present (unlike the former hand-rolled
   * copies) with a `0` cell width, which reads back as an unmeasured terminal.
   */
  _core: MockXtermCore = {
    _renderService: { dimensions: { css: { cell: { width: 0, height: 0 } } } },
  };

  constructor(options?: MockXtermOptions) {
    // Seed options from the constructor args so a ctor-provided value (e.g.
    // `screenReaderMode`) is observable; the component's live-update effect then
    // mutates this same object.
    this.options = { ...(options ?? {}) };
    mockXtermInstances.push(this);
  }
}

/**
 * Every {@link MockXTerm} constructed since the last {@link resetMockXtermInstances}.
 * Vitest isolates modules per test file, so this never leaks across suites; clear
 * it in `beforeEach` for tests that count or index instances.
 */
export const mockXtermInstances: MockXTerm[] = [];

/** Clear {@link mockXtermInstances} (call from a suite's `beforeEach`). */
export function resetMockXtermInstances(): void {
  mockXtermInstances.length = 0;
}

/**
 * The mock module object to return from a `vi.mock("@xterm/xterm")` factory:
 * `{ Terminal: MockXTerm }`.
 */
export function createMockXtermModule(): { Terminal: typeof MockXTerm } {
  return { Terminal: MockXTerm };
}
