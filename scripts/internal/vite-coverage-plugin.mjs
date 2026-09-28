// Opt-in Istanbul instrumentation of the frontend for the Python bridge harness
// (TOOL-005 follow-up, #3657). vite.config.ts calls `coveragePlugins()`.
//
// OFF BY DEFAULT, and off means absent: unless TERMIHUB_FRONTEND_COVERAGE=1 is
// set, `coveragePlugins()` returns an empty list and istanbul-lib-instrument is
// never even imported, so dev and release builds are byte-for-byte what they
// were. Only scripts/internal/build-system-test-app.sh --coverage sets it, and
// only the nightly system-integration Linux leg passes --coverage.
//
// When on, every frontend source file vitest measures (src/**/*.{ts,tsx} minus
// tests, src/test/**, *.d.ts and src/main.tsx, mirroring vitest.config.ts) is
// instrumented BEFORE esbuild strips its types (`enforce: "pre"`). Babel parses
// the TypeScript directly, so every statement, function and branch location in
// `window.__coverage__` is already an original-source location: no source-map
// remapping step is needed when the harness's dump is converted to lcov
// (scripts/internal/istanbul-to-lcov.mjs).
//
// `coverageGlobalScope: "globalThis"` with `coverageGlobalScopeFunc: false`
// keeps the instrumented code free of `new Function(...)`, which the app's CSP
// (no 'unsafe-eval') would block.
import path from "node:path";

/** The env flag that turns instrumentation on. */
export const COVERAGE_ENV = "TERMIHUB_FRONTEND_COVERAGE";

/** True only for an explicit opt-in value. */
export function coverageEnabled(env = process.env) {
  return ["1", "true", "TRUE", "yes"].includes(env[COVERAGE_ENV] ?? "");
}

/**
 * Whether module `id` is a frontend source file the unit coverage also
 * measures. Virtual modules, query-suffixed ids and node_modules are skipped.
 */
export function shouldInstrument(id, root) {
  if (!id || id.startsWith("\0") || id.includes("?")) return false;
  const rel = path.relative(root, id).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  if (!rel.startsWith("src/")) return false;
  if (!/\.(ts|tsx)$/.test(rel)) return false;
  if (rel.endsWith(".d.ts")) return false;
  if (/\.test\.(ts|tsx)$/.test(rel)) return false;
  if (rel.startsWith("src/test/")) return false;
  if (rel === "src/main.tsx") return false;
  return true;
}

/** Babel parser plugins for a file: TypeScript always, JSX only for .tsx. */
export function parserPluginsFor(id, defaults) {
  const extra = id.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"];
  return [...defaults, ...extra];
}

/** Instrumenter options shared by both parser flavours. */
export function instrumenterOptions(parserPlugins) {
  return {
    coverageVariable: "__coverage__",
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
    esModules: true,
    compact: false,
    preserveComments: true,
    produceSourceMap: true,
    autoWrap: true,
    parserPlugins,
  };
}

/** The Vite plugin, given the loaded istanbul-lib-instrument module. */
export function istanbulPlugin(instrumentLib, root) {
  const { createInstrumenter, defaultOpts } = instrumentLib;
  const defaults = defaultOpts?.parserPlugins ?? [];
  const instrumenters = {
    ts: createInstrumenter(instrumenterOptions(parserPluginsFor("x.ts", defaults))),
    tsx: createInstrumenter(instrumenterOptions(parserPluginsFor("x.tsx", defaults))),
  };
  return {
    name: "termihub:istanbul-coverage",
    enforce: "pre",
    transform(code, id) {
      if (!shouldInstrument(id, root)) return null;
      const instrumenter = id.endsWith(".tsx") ? instrumenters.tsx : instrumenters.ts;
      const out = instrumenter.instrumentSync(code, id);
      return { code: out, map: instrumenter.lastSourceMap() ?? null };
    },
  };
}

/**
 * The plugins to add to the Vite config: none unless the flag is set. The
 * instrumenter is loaded lazily so a normal build never imports it.
 */
export async function coveragePlugins(root, env = process.env) {
  if (!coverageEnabled(env)) return [];
  const mod = await import("istanbul-lib-instrument");
  const lib = mod.default ?? mod;
  console.warn(
    `[coverage] ${COVERAGE_ENV} is set: instrumenting src/** with Istanbul (test builds only)`
  );
  return [istanbulPlugin(lib, root)];
}
