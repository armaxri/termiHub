/**
 * Guards the slice → root-store import cycle (ARCH-001/FES-011, #2881).
 *
 * The slices under `./` are composed by `../appStore`. When a slice imported its
 * helpers from `../appStore`, importing that slice *first* evaluated the root
 * store mid-way through the slice's own evaluation, so `create()` called a
 * `createXSlice` that was not defined yet ("createXSlice is not a function").
 * The helpers now live in their own modules, so no slice module may reach
 * `../appStore` at runtime, and a slice can be imported before the root store.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const sliceModules = import.meta.glob(["./*.ts", "!./*.test.ts"]);

describe("slice modules do not import the root store (#2881)", () => {
  afterEach(() => {
    vi.doUnmock("../appStore");
    vi.resetModules();
  });

  it("finds the slice modules", () => {
    expect(Object.keys(sliceModules)).toContain("./layoutSlice.ts");
  });

  it.each(Object.keys(sliceModules))("%s imports without loading appStore", async (path) => {
    vi.resetModules();
    vi.doMock("../appStore", () => {
      throw new Error(`${path} pulled in the root appStore at runtime`);
    });
    await expect(sliceModules[path]()).resolves.toBeDefined();
  });

  it("a slice imported before appStore still composes the store", async () => {
    vi.resetModules();
    const { createLayoutSlice } = await import("./layoutSlice");
    expect(typeof createLayoutSlice).toBe("function");
    const { useAppStore } = await import("../appStore");
    expect(typeof useAppStore.getState().addTab).toBe("function");
    expect(typeof useAppStore.getState().reclaimSession).toBe("function");
  });
});
