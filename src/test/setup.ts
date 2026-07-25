import { vi } from "vitest";

// jsdom omits several DOM APIs that Radix primitives (Tooltip, Select) touch when
// they measure, portal, or probe pointer capture. These shims are global,
// environment-level, and idempotent — each is installed only when jsdom lacks a
// real implementation, so they never clobber a genuine one. Centralizing them here
// lets every component test mount Radix-backed UI without repeating the block.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}
// `Element` is absent in the node test environment (e.g. WebSocket bridge tests),
// so guard the DOM-only shims — they only matter for jsdom component tests anyway.
if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  // @tanstack/react-virtual resets its `isScrolling` flag either from the native
  // `scrollend` event (when the environment advertises `onscrollend` and the
  // virtualizer opts in via `useScrollendEvent`) or, as a fallback, from a 150ms
  // debounced `setTimeout` that its cleanup never clears. That leaked timer fires
  // after the FileBrowser unmounts and — once jsdom has torn the environment down
  // between test files — throws an unhandled "window is not defined" that fails
  // the whole run. jsdom does not implement `onscrollend`, so advertise it here
  // (before any react-virtual module loads) to steer the FileBrowser virtualizer
  // onto the timer-free scrollend path, leaving nothing pending past teardown.
  if (typeof window !== "undefined" && !("onscrollend" in window)) {
    (window as unknown as { onscrollend: ((this: Window, ev: Event) => void) | null }).onscrollend =
      null;
  }

  // jsdom does no layout, so scroll containers report size 0 and a windowing
  // library (@tanstack/react-virtual, used by the FileBrowser) would render an
  // empty window under test. The virtualizer measures its scroll element via
  // offsetHeight/clientHeight and derives the max scroll offset from
  // scrollHeight - clientHeight, so give the FileBrowser's scroll container a
  // real viewport size and a scrollHeight matching its virtual spacer. Then
  // small test directories render in full (as they did pre-virtualization),
  // while large synthetic directories still mount only a subset and can scroll.
  // Only the FileBrowser list opts in; every other element keeps jsdom's zero
  // size, so Radix measurement/positioning stays untouched.
  const FILE_BROWSER_LIST_HEIGHT = 2000;
  const FILE_BROWSER_LIST_WIDTH = 300;
  const isFileBrowserList = (el: unknown): el is HTMLElement =>
    el instanceof HTMLElement && el.classList.contains("file-browser__list");
  /** Total scrollable content height = the virtual spacer's declared height. */
  const fileBrowserScrollHeight = (list: HTMLElement): number => {
    const inner = list.querySelector<HTMLElement>(".file-browser__list-inner");
    const declared = inner ? parseFloat(inner.style.height) : NaN;
    return Number.isNaN(declared) ? FILE_BROWSER_LIST_HEIGHT : declared;
  };
  const overrideDimension = (
    prop: "offsetHeight" | "offsetWidth" | "clientHeight" | "clientWidth" | "scrollHeight",
    measure: (list: HTMLElement) => number
  ): void => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement): number {
        if (isFileBrowserList(this)) return measure(this);
        return original?.get?.call(this) ?? 0;
      },
    });
  };
  overrideDimension("offsetHeight", () => FILE_BROWSER_LIST_HEIGHT);
  overrideDimension("clientHeight", () => FILE_BROWSER_LIST_HEIGHT);
  overrideDimension("offsetWidth", () => FILE_BROWSER_LIST_WIDTH);
  overrideDimension("clientWidth", () => FILE_BROWSER_LIST_WIDTH);
  overrideDimension("scrollHeight", fileBrowserScrollHeight);

  // jsdom's scrollTop/scrollLeft are inert (setting them is a no-op that always
  // reads back 0), but @tanstack/react-virtual reads element.scrollTop to know
  // the scroll offset. Back them with real per-element storage so a programmatic
  // scroll actually sticks.
  const scrollTopStore = new WeakMap<Element, number>();
  const scrollLeftStore = new WeakMap<Element, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement): number {
      return scrollTopStore.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrollTopStore.set(this, value);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
    configurable: true,
    get(this: HTMLElement): number {
      return scrollLeftStore.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrollLeftStore.set(this, value);
    },
  });

  // @tanstack/react-virtual's scrollToIndex() drives the scroll element via
  // scrollTo(); jsdom's implementation is an inert no-op that never updates
  // scrollTop or fires a scroll event, so make it actually move the element and
  // notify listeners. This lets keyboard-nav tests observe an off-screen row
  // being scrolled (and mounted) into view.
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
    // Mirror a real browser's scroll → scrollend sequence so the virtualizer's
    // scrollend-driven `isScrolling` reset runs synchronously (see the
    // `onscrollend` shim above) and never arms the leaked debounce timer.
    this.dispatchEvent(new Event("scrollend"));
  };
}

// Mock monaco-editor so tests don't need a browser environment.
vi.mock("monaco-editor", () => ({
  editor: {
    setTheme: vi.fn(),
  },
  languages: {
    getLanguages: vi.fn(() => [
      { id: "plaintext", aliases: ["Plain Text"] },
      { id: "javascript", aliases: ["JavaScript"] },
      { id: "typescript", aliases: ["TypeScript"] },
      { id: "json", aliases: ["JSON"] },
      { id: "python", aliases: ["Python"] },
      { id: "shell", aliases: ["Shell Script"] },
      { id: "ini", aliases: ["Ini"] },
      { id: "yaml", aliases: ["YAML"] },
      { id: "xml", aliases: ["XML"] },
      { id: "dockerfile", aliases: ["Dockerfile"] },
      { id: "makefile", aliases: ["Makefile"] },
      { id: "cmake", aliases: ["CMake"] },
      { id: "toml", aliases: ["TOML"] },
      { id: "nginx", aliases: ["Nginx"] },
      { id: "nix", aliases: ["Nix"] },
      { id: "ruby", aliases: ["Ruby"] },
      { id: "java", aliases: ["Java"] },
      { id: "cpp", aliases: ["C++"] },
      { id: "rust", aliases: ["Rust"] },
      { id: "go", aliases: ["Go"] },
      { id: "html", aliases: ["HTML"] },
      { id: "css", aliases: ["CSS"] },
      { id: "hcl", aliases: ["HCL"] },
    ]),
    register: vi.fn(),
    setMonarchTokensProvider: vi.fn(),
    setLanguageConfiguration: vi.fn(),
  },
}));

// Mock shiki and @shikijs/monaco to avoid WASM loading in tests.
vi.mock("shiki", () => ({
  createHighlighter: vi.fn().mockResolvedValue({
    loadLanguage: vi.fn().mockResolvedValue(undefined),
  }),
  bundledLanguages: {
    astro: vi.fn(),
    svelte: vi.fn(),
    zig: vi.fn(),
  },
  bundledLanguagesInfo: [
    { id: "astro", name: "Astro" },
    { id: "svelte", name: "Svelte" },
    { id: "zig", name: "Zig" },
    { id: "cmake", name: "CMake" },
    { id: "toml", name: "TOML" },
    { id: "nginx", name: "Nginx" },
    { id: "nix", name: "Nix" },
    { id: "lua", name: "Lua" },
  ],
}));

vi.mock("@shikijs/monaco", () => ({
  shikiToMonaco: vi.fn(),
}));

// Mock Tauri core API to prevent import errors when modules load
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    label: "main",
    onFocusChanged: vi.fn(() => Promise.resolve(() => {})),
    setSize: vi.fn(() => Promise.resolve()),
  })),
  LogicalSize: class {
    constructor(
      public width: number,
      public height: number
    ) {}
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn().mockResolvedValue(""),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
