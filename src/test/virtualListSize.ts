/**
 * Opt-in jsdom sizing + scroll backing for `@tanstack/react-virtual` lists
 * (audit finding MOCK-008).
 *
 * jsdom performs no layout, so a scroll container reports `offsetHeight` /
 * `clientHeight` / `scrollHeight` of 0 and a windowing library renders an empty
 * (or overscan-only) window under test. `scrollTop` / `scrollLeft` are inert
 * no-ops, and `scrollTo()` neither moves the element nor fires a scroll event.
 * A virtualized component therefore needs the test to *give* its scroll element
 * a real viewport size and a working scroll before its rows mount and its
 * keyboard-nav scroll-into-view behaves like a browser.
 *
 * This used to live as an always-on block in the global `src/test/setup.ts`,
 * where it monkey-patched a hard-coded `2000px` box onto `HTMLElement.prototype`
 * for *every* test regardless of the component under test — a hidden global
 * constant that reduced test trustworthiness (MOCK-008). It is now an explicit,
 * per-suite opt-in: a test that renders a virtualized list calls
 * {@link setupVirtualListSizing} (or {@link installVirtualListSizing}) and states
 * the size it wants, so element size is visible in the test rather than assumed.
 *
 * The overrides are class-keyed (only elements carrying `listClass` are sized),
 * so Radix measurement/positioning and every non-virtualized element keep
 * jsdom's real zero size.
 */

/** Options for {@link installVirtualListSizing} / {@link setupVirtualListSizing}. */
export interface VirtualListSizeOptions {
  /**
   * CSS class identifying the virtualized scroll viewport. Only elements with
   * this class are given a size; everything else keeps jsdom's zero size.
   * Defaults to the FileBrowser list (`file-browser__list`).
   */
  listClass?: string;
  /**
   * CSS class of the inner spacer element whose declared `style.height` is the
   * total scrollable content height. The viewport's `scrollHeight` mirrors it so
   * the virtualizer derives the correct max scroll offset. Defaults to
   * `file-browser__list-inner`.
   */
  innerClass?: string;
  /** Viewport height in px reported via `offsetHeight` / `clientHeight`. Default 2000. */
  height?: number;
  /** Viewport width in px reported via `offsetWidth` / `clientWidth`. Default 300. */
  width?: number;
}

const DEFAULTS = {
  listClass: "file-browser__list",
  innerClass: "file-browser__list-inner",
  height: 2000,
  width: 300,
} as const;

type Dimension = "offsetHeight" | "offsetWidth" | "clientHeight" | "clientWidth" | "scrollHeight";

/** Prototype descriptors we replace, captured on first install so they can be restored. */
const savedDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
let savedScrollTo: typeof Element.prototype.scrollTo | undefined;
let installCount = 0;

// Per-element scroll offset storage. jsdom's scrollTop/scrollLeft are inert (a set
// is a no-op that always reads back 0), but @tanstack/react-virtual reads
// element.scrollTop to know the scroll offset, so back them with real storage.
const scrollTopStore = new WeakMap<Element, number>();
const scrollLeftStore = new WeakMap<Element, number>();

/**
 * Give a single element an explicit measured size under jsdom. Overrides this
 * element instance's `offsetHeight` / `clientHeight` / `offsetWidth` /
 * `clientWidth` (and, when provided, `scrollHeight`) so a virtualizer measuring
 * it reads real dimensions instead of jsdom's zero. Useful for a test that holds
 * the scroll element directly (rather than sizing by class via
 * {@link installVirtualListSizing}).
 */
export function setElementSize(
  el: HTMLElement,
  size: { width?: number; height?: number; scrollHeight?: number }
): void {
  const define = (prop: Dimension, value: number): void => {
    Object.defineProperty(el, prop, { configurable: true, get: () => value });
  };
  if (size.height !== undefined) {
    define("offsetHeight", size.height);
    define("clientHeight", size.height);
  }
  if (size.width !== undefined) {
    define("offsetWidth", size.width);
    define("clientWidth", size.width);
  }
  if (size.scrollHeight !== undefined) {
    define("scrollHeight", size.scrollHeight);
  }
}

/**
 * Install class-keyed sizing + working scroll on `HTMLElement.prototype` /
 * `Element.prototype` so a virtualized list identified by `listClass` mounts and
 * scrolls under jsdom. Idempotent and ref-counted; returns an uninstaller that
 * restores the original prototype behaviour once every install is undone.
 */
export function installVirtualListSizing(options: VirtualListSizeOptions = {}): () => void {
  const listClass = options.listClass ?? DEFAULTS.listClass;
  const innerClass = options.innerClass ?? DEFAULTS.innerClass;
  const height = options.height ?? DEFAULTS.height;
  const width = options.width ?? DEFAULTS.width;

  installCount += 1;
  if (installCount > 1) {
    // Already installed for an outer suite; just hand back the uninstaller.
    return makeUninstaller();
  }

  const isVirtualList = (el: unknown): el is HTMLElement =>
    el instanceof HTMLElement && el.classList.contains(listClass);

  /** Total scrollable content height = the inner spacer's declared height. */
  const scrollHeightOf = (list: HTMLElement): number => {
    const inner = list.querySelector<HTMLElement>(`.${innerClass}`);
    const declared = inner ? parseFloat(inner.style.height) : NaN;
    return Number.isNaN(declared) ? height : declared;
  };

  const overrideDimension = (prop: Dimension, measure: (list: HTMLElement) => number): void => {
    if (!savedDescriptors.has(prop)) {
      savedDescriptors.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
    }
    const original = savedDescriptors.get(prop);
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement): number {
        if (isVirtualList(this)) return measure(this);
        return original?.get?.call(this) ?? 0;
      },
    });
  };

  overrideDimension("offsetHeight", () => height);
  overrideDimension("clientHeight", () => height);
  overrideDimension("offsetWidth", () => width);
  overrideDimension("clientWidth", () => width);
  overrideDimension("scrollHeight", scrollHeightOf);

  for (const prop of ["scrollTop", "scrollLeft"] as const) {
    if (!savedDescriptors.has(prop)) {
      savedDescriptors.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
    }
    const store = prop === "scrollTop" ? scrollTopStore : scrollLeftStore;
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement): number {
        return store.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        store.set(this, value);
      },
    });
  }

  // @tanstack/react-virtual's scrollToIndex() drives the element via scrollTo();
  // jsdom's is an inert no-op that never updates scrollTop or fires a scroll
  // event, so make it actually move the element and notify listeners. A real
  // browser's scroll → scrollend sequence is mirrored so a virtualizer using the
  // native scrollend path (see the `onscrollend` shim in setup.ts) resets its
  // `isScrolling` flag synchronously and never arms the leaked debounce timer.
  savedScrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function scrollTo(
    xOrOptions?: number | ScrollToOptions,
    y?: number
  ): void {
    if (typeof xOrOptions === "object" && xOrOptions !== null) {
      if (typeof xOrOptions.top === "number") this.scrollTop = xOrOptions.top;
      if (typeof xOrOptions.left === "number") this.scrollLeft = xOrOptions.left;
    } else {
      if (typeof xOrOptions === "number") this.scrollLeft = xOrOptions;
      if (typeof y === "number") this.scrollTop = y;
    }
    this.dispatchEvent(new Event("scroll"));
    this.dispatchEvent(new Event("scrollend"));
  };

  return makeUninstaller();
}

/** Build an idempotent uninstaller for a single {@link installVirtualListSizing} call. */
function makeUninstaller(): () => void {
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    installCount -= 1;
    if (installCount > 0) return;
    // Last install undone — restore the original prototype behaviour.
    for (const [prop, descriptor] of savedDescriptors) {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, prop, descriptor);
      } else {
        delete (HTMLElement.prototype as unknown as Record<PropertyKey, unknown>)[prop];
      }
    }
    savedDescriptors.clear();
    if (savedScrollTo) {
      Element.prototype.scrollTo = savedScrollTo;
    } else {
      delete (Element.prototype as unknown as Record<string, unknown>).scrollTo;
    }
    savedScrollTo = undefined;
  };
}

/**
 * vitest opt-in: install class-keyed virtual-list sizing for the calling test
 * suite. Call once at module scope (alongside the region harness). The install
 * lasts for the test file — mirroring how the sizing used to be applied globally
 * — but only in suites that ask for it, and with the size stated explicitly.
 */
export function setupVirtualListSizing(options?: VirtualListSizeOptions): void {
  installVirtualListSizing(options);
}
