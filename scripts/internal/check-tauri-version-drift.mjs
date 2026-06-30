#!/usr/bin/env node
// Detect drift between the installed @tauri-apps/* npm packages and their
// matching Rust crates.
//
// `pnpm tauri build` aborts before building if an npm package and its Rust
// crate are not on the same major/minor release (e.g. tauri 2.11.2 vs
// @tauri-apps/api 2.10.1). That precheck only runs at build time, so the drift
// can sneak onto `develop` and only surface when someone tries to build (see
// issue #1014). This script reproduces the same major/minor comparison so
// `release-check` (and anyone running it directly) can flag the drift early.
//
// The pure helpers are exported for unit testing — see
// check-tauri-version-drift.test.mjs. A single cross-platform Node
// implementation avoids duplicating fragile lockfile parsing across the bash
// and cmd release-check variants.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/** Repository root, derived from this file's location (scripts/internal/). */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Extract the `major.minor` portion of a semver string.
 *
 * @param {string | null | undefined} version - e.g. "2.11.2".
 * @returns {string | null} e.g. "2.11", or null if unparseable.
 */
export function minorOf(version) {
  if (typeof version !== "string") {
    return null;
  }
  const match = version.match(/^\s*v?(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : null;
}

/**
 * Read a crate's resolved version from a Cargo.lock file's contents.
 *
 * @param {string} cargoLock - Full text of Cargo.lock.
 * @param {string} crateName - Exact crate name, e.g. "tauri-plugin-fs".
 * @returns {string | null} The version, or null if the crate is absent.
 */
export function parseCargoCrateVersion(cargoLock, crateName) {
  if (typeof cargoLock !== "string") {
    return null;
  }
  // Cargo.lock lists each package as a [[package]] block with `name` followed
  // by `version`. Match the exact name (anchored) then the next version line.
  const escaped = crateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^name = "${escaped}"\\r?\\n\\s*version = "([^"]+)"`, "m");
  const match = cargoLock.match(re);
  return match ? match[1] : null;
}

/**
 * Map the @tauri-apps/* npm dependencies declared in package.json to their
 * matching Rust crate names.
 *
 * `@tauri-apps/api` → `tauri`; `@tauri-apps/plugin-<x>` → `tauri-plugin-<x>`.
 * `@tauri-apps/cli` is a dev-only tool with no embedded crate and is skipped.
 *
 * @param {object} packageJson - Parsed package.json.
 * @returns {{ npm: string, crate: string }[]} Pairs to compare.
 */
export function tauriPairs(packageJson) {
  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  const pairs = [];
  for (const npm of Object.keys(deps)) {
    if (!npm.startsWith("@tauri-apps/")) {
      continue;
    }
    const suffix = npm.slice("@tauri-apps/".length);
    if (suffix === "api") {
      pairs.push({ npm, crate: "tauri" });
    } else if (suffix.startsWith("plugin-")) {
      pairs.push({ npm, crate: `tauri-${suffix}` });
    }
    // @tauri-apps/cli (and any other non-embedded tooling) intentionally skipped.
  }
  return pairs.sort((a, b) => a.npm.localeCompare(b.npm));
}

/**
 * Compare resolved npm and crate versions, partitioning the pairs into drift
 * (major/minor mismatch — blocking) and skipped (a version could not be
 * resolved — non-blocking, e.g. crate missing or deps not installed).
 *
 * @param {{ npm: string, crate: string, npmVersion: string|null, crateVersion: string|null }[]} pairs
 * @returns {{ ok: object[], drift: object[], skipped: object[] }}
 */
export function findDrift(pairs) {
  const ok = [];
  const drift = [];
  const skipped = [];
  for (const pair of pairs) {
    const npmMinor = minorOf(pair.npmVersion);
    const crateMinor = minorOf(pair.crateVersion);
    if (npmMinor === null || crateMinor === null) {
      skipped.push(pair);
    } else if (npmMinor === crateMinor) {
      ok.push(pair);
    } else {
      drift.push(pair);
    }
  }
  return { ok, drift, skipped };
}

/** Read the resolved npm version from an installed package's package.json. */
function installedNpmVersion(npmPkg) {
  try {
    const pkgPath = path.join(ROOT, "node_modules", npmPkg, "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** Gather resolved versions and run the drift comparison against the repo. */
export function checkRepo() {
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const cargoLock = readFileSync(path.join(ROOT, "Cargo.lock"), "utf8");
  const pairs = tauriPairs(packageJson).map((pair) => ({
    ...pair,
    npmVersion: installedNpmVersion(pair.npm),
    crateVersion: parseCargoCrateVersion(cargoLock, pair.crate),
  }));
  return findDrift(pairs);
}

// CLI mode: print a per-pair report and exit non-zero on drift so callers
// (release-check, CI) can gate on it.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, drift, skipped } = checkRepo();

  for (const p of ok) {
    process.stdout.write(`  ok    ${p.crate} (${p.crateVersion}) : ${p.npm} (${p.npmVersion})\n`);
  }
  for (const p of skipped) {
    process.stdout.write(
      `  skip  ${p.crate} (${p.crateVersion ?? "n/a"}) : ${p.npm} (${p.npmVersion ?? "not installed"})\n`,
    );
  }
  for (const p of drift) {
    process.stdout.write(
      `  DRIFT ${p.crate} (${p.crateVersion}) : ${p.npm} (${p.npmVersion}) — major/minor mismatch\n`,
    );
  }

  if (drift.length > 0) {
    process.stdout.write(
      "\nTauri npm packages and Rust crates have drifted apart. `pnpm tauri build` will\n" +
        "refuse to build until they are realigned. Bump the npm package(s) to match the\n" +
        "crate major/minor (or pin the crate(s) down to the npm version).\n",
    );
    process.exit(1);
  }
}
