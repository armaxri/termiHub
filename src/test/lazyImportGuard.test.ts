import { describe, expect, it } from "vitest";
import {
  createTrackedLazy,
  describeLazyFactory,
  drainPendingLazyImports,
  pendingLazyImports,
  trackLazyImport,
} from "./lazyImportGuard";
import type { lazy } from "react";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("lazyImportGuard (#5370)", () => {
  it("labels a factory by its imported module", () => {
    const transformed = new Function(
      'return () => __vite_ssr_dynamic_import__("/src/components/FileEditor/index.ts")'
    )() as () => unknown;
    expect(describeLazyFactory(transformed)).toBe("/src/components/FileEditor/index.ts");
    const plain = new Function('return () => import("./Target")')() as () => unknown;
    expect(describeLazyFactory(plain)).toBe("./Target");
  });

  it("falls back to the factory source when no import is found", () => {
    expect(describeLazyFactory(() => Promise.resolve(1))).toContain("Promise.resolve");
  });

  it("reports nothing when no import is in flight", async () => {
    expect(await drainPendingLazyImports("now")).toBeNull();
  });

  it("tracks an import until it settles", async () => {
    const d = deferred<string>();
    void trackLazyImport("/src/A.tsx", d.promise);
    expect(pendingLazyImports()).toEqual(["/src/A.tsx"]);
    d.resolve("done");
    await d.promise;
    await Promise.resolve();
    expect(pendingLazyImports()).toEqual([]);
  });

  it("untracks a rejected import too", async () => {
    const failing = Promise.reject(new Error("boom"));
    void trackLazyImport("/src/B.tsx", failing).catch(() => {});
    await failing.catch(() => {});
    await Promise.resolve();
    expect(pendingLazyImports()).toEqual([]);
  });

  it("waits for an in-flight import, then returns an error naming it", async () => {
    const d = deferred<string>();
    void trackLazyImport("/src/C.tsx", d.promise);
    setTimeout(() => d.resolve("late"), 10);
    const error = await drainPendingLazyImports("when the test ended");
    expect(error?.message).toContain("still loading when the test ended");
    expect(error?.message).toContain("  - /src/C.tsx");
    expect(error?.message).toContain("vi.mock");
    expect(pendingLazyImports()).toEqual([]);
  });

  it("wraps React.lazy so the factory's import is tracked", async () => {
    const d = deferred<{ default: () => null }>();
    let captured: (() => Promise<unknown>) | undefined;
    const fakeLazy = ((factory: () => Promise<unknown>) => {
      captured = factory;
      return {};
    }) as unknown as typeof lazy;
    createTrackedLazy(fakeLazy)(() => d.promise);
    expect(pendingLazyImports()).toEqual([]);
    const loading = captured?.();
    expect(pendingLazyImports()).toHaveLength(1);
    d.resolve({ default: () => null });
    await loading;
    await Promise.resolve();
    expect(pendingLazyImports()).toEqual([]);
  });
});
