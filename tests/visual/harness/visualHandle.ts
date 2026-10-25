/**
 * What harness/boot.ts exposes on `window.__visual` for the Playwright specs.
 * A plain type module so every spec declares the same global.
 */

/** The app store's state: actions by name, plus plain fields. */
export type VisualStoreState = Record<string, (...args: unknown[]) => unknown>;

export interface VisualHandle {
  /** The app store (the same module instance the app uses). */
  store: { getState(): VisualStoreState };
  /** Emit a backend event to the app's mocked listeners (terminal output, #4949). */
  emit(event: string, payload: unknown): Promise<void>;
  /** Apply a theme setting (`"dark"`, `"light"`, …) without a settings round trip. */
  applyTheme(setting: string): void;
}
