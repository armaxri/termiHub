import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isTestBridgeEnabled, TEST_BRIDGE_STORAGE_KEY, TEST_BRIDGE_GLOBAL_KEY } from "./testMode";

/** A minimal in-memory Storage, since this jsdom build ships a non-functional stub. */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    key: (i) => Array.from(map.keys())[i] ?? null,
  };
}

describe("isTestBridgeEnabled", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      value: createMemoryStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    delete (window as Record<string, unknown>)[TEST_BRIDGE_GLOBAL_KEY];
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("is disabled by default", () => {
    expect(isTestBridgeEnabled()).toBe(false);
  });

  it("is enabled by the runtime global", () => {
    (window as Record<string, unknown>)[TEST_BRIDGE_GLOBAL_KEY] = true;
    expect(isTestBridgeEnabled()).toBe(true);
  });

  it("is enabled by the ?testBridge=1 query parameter", () => {
    window.history.replaceState({}, "", "/?testBridge=1");
    expect(isTestBridgeEnabled()).toBe(true);
  });

  it("is enabled by the persisted localStorage flag", () => {
    window.localStorage.setItem(TEST_BRIDGE_STORAGE_KEY, "1");
    expect(isTestBridgeEnabled()).toBe(true);
  });

  it("ignores unrelated query parameters and storage values", () => {
    window.history.replaceState({}, "", "/?testBridge=0&other=1");
    window.localStorage.setItem(TEST_BRIDGE_STORAGE_KEY, "no");
    expect(isTestBridgeEnabled()).toBe(false);
  });
});
