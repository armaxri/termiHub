import { expect, vi } from "vitest";
import { toHaveNoViolations } from "jest-axe";

// Register the jest-axe accessibility matcher globally so any test can assert
// `expect(await checkA11y()).toHaveNoViolations()` (audit finding TFE-012). The
// audit helper + the "how to add an a11y test" pattern live in `src/test/axe.ts`.
// The matcher is framework-agnostic (a plain `{ pass, message }` result), so it
// plugs straight into Vitest's `expect.extend`.
expect.extend(toHaveNoViolations);

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must mirror Vitest's own `Assertion<T = any>` signature for declaration merging.
  interface Assertion<T = any> {
    toHaveNoViolations(): T;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}

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

  // jsdom does not implement `window.matchMedia`. uPlot (the monitoring/latency
  // charts) calls it at *module load* to pick a pixel ratio, and the theme
  // engine reads `prefers-color-scheme` through it — so a test that mounts any
  // chart-bearing UI (or the whole App shell) blows up on import without this.
  // Return an inert, listener-shaped MediaQueryList so callers can subscribe
  // without effect. Idempotent: only installed when jsdom lacks it, so tests
  // that stub their own matchMedia (e.g. themes/engine.test.ts) still win.
  if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }

  // @tanstack/react-virtual resets its `isScrolling` flag either from the native
  // `scrollend` event (when the environment advertises `onscrollend` and the
  // virtualizer opts in via `useScrollendEvent`) or, as a fallback, from a 150ms
  // debounced `setTimeout` that its cleanup never clears. That leaked timer fires
  // after a virtualized list (the FileBrowser) unmounts and — once jsdom has torn
  // the environment down between test files — throws an unhandled "window is not
  // defined" that fails the whole run.
  //
  // The unclear-on-unmount timer is a bug inside the `@tanstack/virtual-core`
  // dependency (`observeOffset`'s cleanup removes the scroll listener but never
  // clears the fallback debounce), not our code — see follow-up issue and the
  // regression test in `src/test/virtualListSize.test.tsx`, which asserts the
  // scrollend path leaves `vi.getTimerCount() === 0` while the debounce fallback
  // leaks one timer. jsdom does not implement `onscrollend`, so advertise it here
  // — at module load, because `virtual-core` captures `"onscrollend" in window`
  // in a top-level `const` when it first loads — to steer the virtualizer onto
  // the timer-free scrollend path (it opts in via `useScrollendEvent: true`),
  // leaving nothing pending past teardown. This shim must stay global; the
  // per-test sizing/scroll helpers moved to `src/test/virtualListSize.ts` as an
  // explicit opt-in (audit finding MOCK-008), but this one is load-time-bound.
  if (typeof window !== "undefined" && !("onscrollend" in window)) {
    (window as unknown as { onscrollend: ((this: Window, ev: Event) => void) | null }).onscrollend =
      null;
  }
}

// Mock monaco-editor so tests don't need a browser environment.
// NOTE: the hard-coded `getLanguages()` list below includes termiHub's built-in
// custom languages (cmake, toml, nginx, nix). It is kept in sync with the real
// registration by `monacoCustomLanguages.setup-sync.test.ts` (guards MOCK-007) —
// if you add/remove a built-in language in `utils/monacoCustomLanguages.ts`,
// update this list too or that guard test will fail.
vi.mock("monaco-editor", () => ({
  editor: {
    setTheme: vi.fn(),
    registerLinkOpener: vi.fn(),
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
    onCloseRequested: vi.fn(() => Promise.resolve(() => {})),
    setSize: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(() => Promise.resolve()),
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
  openPath: vi.fn().mockResolvedValue(undefined),
}));
