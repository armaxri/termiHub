import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test helpers that compute the **effective** webview Content-Security-Policy
 * the way Tauri does at build time (#3627).
 *
 * The CSP is declared as a directive map in `src-tauri/tauri.conf.json`. Tauri
 * then applies, in order, an RFC 7396 JSON merge patch from the
 * platform-specific file (`tauri.windows.conf.json` / `tauri.macos.conf.json` /
 * `tauri.linux.conf.json`, when present). Because the policy is a map, an overlay
 * can replace one directive without restating the rest.
 *
 * The system-test build has no config overlay (#3628): it ships the platform's
 * production policy and the test bridge widens `connect-src` at startup
 * (`relax_csp_policy` in `src-tauri/src/utils/test_bridge.rs`). `effectiveCsp`
 * with `testBuild` models that widening, reading the bridge sources straight
 * from the Rust constant so the two cannot drift.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_TAURI = join(REPO_ROOT, "src-tauri");

export type CspPlatform = "macos" | "linux" | "windows";
export const CSP_PLATFORMS: readonly CspPlatform[] = ["macos", "linux", "windows"];

/** A parsed policy: directive name → its source tokens, in declared order. */
export type CspMap = Record<string, string[]>;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Read a `src-tauri/<file>` config as JSON, or `null` when it does not exist. */
export function readTauriConfig(file: string): Record<string, Json> | null {
  const path = join(SRC_TAURI, file);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, Json>;
}

/** RFC 7396 JSON merge patch — the algorithm Tauri uses to layer config files. */
export function mergePatch(target: Json, patch: Json): Json {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base: { [key: string]: Json } =
    target !== null && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else base[key] = mergePatch(base[key] ?? null, value);
  }
  return base;
}

/** Parse a CSP in either Tauri form (policy string or directive map) into a `CspMap`. */
export function toCspMap(csp: Json): CspMap {
  const out: CspMap = {};
  if (typeof csp === "string") {
    for (const clause of csp.split(";")) {
      const [directive, ...sources] = clause.trim().split(/\s+/).filter(Boolean);
      if (directive) out[directive] = sources;
    }
    return out;
  }
  if (csp === null || typeof csp !== "object" || Array.isArray(csp)) {
    throw new Error(`app.security.csp must be a string or a directive map, got ${String(csp)}`);
  }
  for (const [directive, sources] of Object.entries(csp)) {
    if (typeof sources === "string") out[directive] = sources.split(/\s+/).filter(Boolean);
    else if (Array.isArray(sources) && sources.every((s) => typeof s === "string")) {
      out[directive] = (sources as string[]).flatMap((s) => s.split(/\s+/).filter(Boolean));
    } else {
      throw new Error(`CSP directive ${directive} has a non-string source list`);
    }
  }
  return out;
}

/** The merged production `app.security` block for a platform. */
export function effectiveSecurity(platform: CspPlatform): Record<string, Json> {
  let conf: Json = readTauriConfig("tauri.conf.json");
  const platformPatch = readTauriConfig(`tauri.${platform}.conf.json`);
  if (platformPatch) conf = mergePatch(conf, platformPatch);
  const app = (conf as Record<string, Json>).app as Record<string, Json> | undefined;
  return (app?.security ?? {}) as Record<string, Json>;
}

/**
 * The `connect-src` sources the test bridge appends at runtime, parsed from
 * `TEST_BRIDGE_CSP_CONNECT_SRC` in `src-tauri/src/utils/test_bridge.rs`.
 */
export function testBridgeConnectSources(): string[] {
  const source = readFileSync(join(SRC_TAURI, "src", "utils", "test_bridge.rs"), "utf8");
  const match = /pub const TEST_BRIDGE_CSP_CONNECT_SRC: &str = "([^"]*)";/.exec(source);
  if (!match) throw new Error("TEST_BRIDGE_CSP_CONNECT_SRC not found in test_bridge.rs");
  return match[1].split(/\s+/).filter(Boolean);
}

/**
 * The effective CSP for a platform: the production build, or with `testBuild`
 * the test-bridge build after its runtime `connect-src` widening (mirrors
 * `relax_csp_policy`: append missing sources in order, or add
 * `connect-src 'self' <sources>` when the directive is absent).
 */
export function effectiveCsp(platform: CspPlatform, opts: { testBuild?: boolean } = {}): CspMap {
  const csp = toCspMap(effectiveSecurity(platform).csp ?? null);
  if (!opts.testBuild) return csp;
  const connect = csp["connect-src"] ? [...csp["connect-src"]] : ["'self'"];
  for (const source of testBridgeConnectSources()) {
    if (!connect.includes(source)) connect.push(source);
  }
  return { ...csp, "connect-src": connect };
}
