/**
 * Detection for the in-app test bridge "test mode".
 *
 * The bridge is a development/testing surface and must stay dormant in normal
 * use. It activates only when one of several explicit opt-in signals is present,
 * so it can be enabled from a build, a URL, persisted browser state, or a
 * runtime global injected by the backend — and is OFF by default everywhere else.
 */

/** Key under which test mode can be persisted in `localStorage`. */
export const TEST_BRIDGE_STORAGE_KEY = "termihub.testBridge";

/** Global flag the backend (or a harness) can set before the app boots. */
export const TEST_BRIDGE_GLOBAL_KEY = "__TERMIHUB_TEST_BRIDGE__";

/**
 * Whether the in-app test bridge should be active.
 *
 * Returns true when any opt-in signal is present:
 *  - build-time `VITE_TEST_BRIDGE=1`,
 *  - a `?testBridge=1` query parameter,
 *  - `localStorage["termihub.testBridge"] === "1"`,
 *  - a truthy `window.__TERMIHUB_TEST_BRIDGE__` global.
 *
 * Every probe is guarded so a missing or throwing environment (e.g. blocked
 * storage) simply contributes `false` rather than breaking app startup.
 */
export function isTestBridgeEnabled(): boolean {
  return (
    // Build-time flag — baked into dev/test builds, never production by default.
    checkSignal(() => import.meta.env?.VITE_TEST_BRIDGE === "1") ||
    // Runtime global, e.g. injected by the backend init script in test mode.
    checkSignal(() => !!(window as unknown as Record<string, unknown>)[TEST_BRIDGE_GLOBAL_KEY]) ||
    // URL query parameter.
    checkSignal(() => new URLSearchParams(window.location.search).get("testBridge") === "1") ||
    // Persisted opt-in.
    checkSignal(() => window.localStorage?.getItem(TEST_BRIDGE_STORAGE_KEY) === "1")
  );
}

/**
 * Evaluate one opt-in signal, treating any thrown/absent environment (blocked
 * storage, missing `window`, …) as a `false` contribution rather than an error.
 */
function checkSignal(probe: () => boolean): boolean {
  try {
    return probe();
  } catch {
    return false;
  }
}
