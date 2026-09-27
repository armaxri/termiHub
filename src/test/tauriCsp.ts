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
 * `tauri.linux.conf.json`, when present) and any `--config` overlay (the
 * system-test build passes `tauri.test.conf.json`). Because the policy is a map,
 * an overlay can replace one directive without restating the rest.
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

/** The merged `app.security` block for a platform, optionally with the test overlay. */
export function effectiveSecurity(
  platform: CspPlatform,
  opts: { testBuild?: boolean } = {}
): Record<string, Json> {
  let conf: Json = readTauriConfig("tauri.conf.json");
  const platformPatch = readTauriConfig(`tauri.${platform}.conf.json`);
  if (platformPatch) conf = mergePatch(conf, platformPatch);
  if (opts.testBuild) {
    const testPatch = readTauriConfig("tauri.test.conf.json");
    if (testPatch) conf = mergePatch(conf, testPatch);
  }
  const app = (conf as Record<string, Json>).app as Record<string, Json> | undefined;
  return (app?.security ?? {}) as Record<string, Json>;
}

/** The effective CSP for a platform (production build unless `testBuild`). */
export function effectiveCsp(platform: CspPlatform, opts: { testBuild?: boolean } = {}): CspMap {
  return toCspMap(effectiveSecurity(platform, opts).csp ?? null);
}
