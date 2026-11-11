/**
 * Lazy-import guard for the vitest suite (#5370).
 *
 * A test that renders a `React.lazy` surface and ends while its dynamic import
 * is still loading corrupts the `@vitest/coverage-v8` report for the lazily
 * imported module (#5358):
 *
 * - V8 has already compiled the module's script, so the worker reports
 *   coverage for it, but vitest never recorded the module as executed. The
 *   entry's `startOffset` (the length of vitest's module wrapper) is therefore 0.
 * - `generateCoverage` merges the per-test-file coverage with `mergeProcessCovs`
 *   and keeps the `startOffset` of the last entry it reads for a URL. The read
 *   order depends on the filesystem. When the stray 0 is read last, every V8
 *   range lands one wrapper-length too late and the whole file's coverage map is
 *   a shifted copy of the real one.
 *
 * This guard wraps `React.lazy` (via the `vi.mock("react")` in `setup.ts`) so
 * each lazy factory's import promise is tracked. After every test, and once more
 * after every test file, it checks for imports that are still in flight. If it
 * finds any, it first waits for them to settle, so the module finishes
 * evaluating and its coverage stays correct, and then fails the test with a
 * message that names the module and says how to fix the test.
 *
 * Fixing a test the guard flags: either stub the lazy surface
 * (`vi.mock("@/components/FileEditor", () => ({ FileEditor: () => null }))`)
 * when the test does not care about it, or await it (for example wait for an
 * element the lazy component renders) when the test does.
 */
import { afterAll, afterEach } from "vitest";
import type { lazy } from "react";

/** Upper bound on waiting for a stray import to settle before failing the test. */
export const LAZY_IMPORT_SETTLE_TIMEOUT_MS = 10_000;

interface PendingImport {
  label: string;
  promise: Promise<unknown>;
}

const pending = new Set<PendingImport>();

/**
 * Derives a readable label (the imported module specifier) from a lazy factory.
 * After vitest's transform the factory body reads like
 * `() => __vite_ssr_dynamic_import__("/src/components/FileEditor/index.ts")`.
 */
export function describeLazyFactory(factory: () => unknown): string {
  const source = String(factory);
  const match =
    /import__\s*\(\s*["'`]([^"'`]+)["'`]/.exec(source) ??
    /import\s*\(\s*["'`]([^"'`]+)["'`]/.exec(source);
  return match ? match[1] : source.replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Records `promise` as an in-flight lazy import until it settles. Exported for
 * the guard's own tests; production code never calls it.
 */
export function trackLazyImport<T>(label: string, promise: Promise<T>): Promise<T> {
  const entry: PendingImport = { label, promise };
  pending.add(entry);
  const done = () => {
    pending.delete(entry);
  };
  promise.then(done, done);
  return promise;
}

/** Labels of the lazy imports still in flight. */
export function pendingLazyImports(): string[] {
  return [...pending].map((entry) => entry.label);
}

/**
 * Returns a `React.lazy` replacement that tracks every factory call. React calls
 * the factory once, on the first render of the lazy component.
 */
export function createTrackedLazy(realLazy: typeof lazy): typeof lazy {
  return (factory) => {
    const label = describeLazyFactory(factory);
    return realLazy(() => trackLazyImport(label, factory()));
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for the in-flight imports to settle (bounded) and returns the error to
 * fail the test with, or `null` when nothing was in flight.
 */
export async function drainPendingLazyImports(when: string): Promise<Error | null> {
  if (pending.size === 0) {
    return null;
  }
  const entries = [...pending];
  await Promise.race([
    Promise.allSettled(entries.map((entry) => entry.promise)),
    sleep(LAZY_IMPORT_SETTLE_TIMEOUT_MS),
  ]);
  const modules = [...new Set(entries.map((entry) => entry.label))]
    .map((m) => `  - ${m}`)
    .join("\n");
  return new Error(
    `A React.lazy import was still loading ${when} (#5370):\n${modules}\n` +
      "A test that ends with a lazy import in flight corrupts the coverage report for that " +
      "module (see src/test/lazyImportGuard.ts). Stub the lazy surface with vi.mock when the " +
      "test does not need it, or await what the lazy component renders when it does."
  );
}

/** Registers the per-test and per-file checks. Called once from `setup.ts`. */
export function installLazyImportGuard(): void {
  afterEach(async () => {
    const error = await drainPendingLazyImports("when the test ended");
    if (error) throw error;
  });
  afterAll(async () => {
    const error = await drainPendingLazyImports("when the test file ended");
    if (error) throw error;
  });
}
