/**
 * Map a release version to the numeric Windows MSI version (#4283, PKG2-003).
 *
 * Tauri's WiX bundler only accepts major.minor.patch[.revision] with
 * major/minor <= 255 and patch/revision <= 65535; it rejects a semver
 * prerelease such as `0.2.0-beta.1`. Release tags may carry `-beta.N` or
 * `-rc.N` (docs/contributing.md → "Release"), so release.yml maps EVERY tag
 * through this script and passes the result as `bundle.windows.wix.version`
 * in a generated `--config` fragment on the Windows leg:
 *
 *   X.Y.Z-beta.N  ->  X.Y.Z.(10000 + N)   N = 0..9999
 *   X.Y.Z-rc.N    ->  X.Y.Z.(20000 + N)   N = 0..9999
 *   X.Y.Z         ->  X.Y.Z.30000
 *
 * The final release gets a revision too, so beta < rc < final holds in all four
 * fields (unset, Tauri would emit X.Y.Z = X.Y.Z.0, below every prerelease).
 * Windows Installer ignores the fourth field when it looks for related
 * products, but Tauri's MajorUpgrade element either allows downgrades
 * (allowDowngrades, the default) or same-version upgrades, so each install
 * still replaces the previous beta/rc/final of the same X.Y.Z.
 *
 * Any other prerelease (alpha, numeric-only, extra identifiers) or build
 * metadata is rejected; verify-version runs `--check` so such a tag fails
 * before the GitHub release is created.
 *
 * Usage:
 *   node scripts/internal/msi-version.mjs <version>                  print the MSI version
 *   node scripts/internal/msi-version.mjs --check <version>          exit 1 if unsupported
 *   node scripts/internal/msi-version.mjs --config-out <file> <version>
 *                                                write {"bundle":{"windows":{"wix":{…}}}}
 * <version> may carry a leading `v` (the tag name). Exit 2 = bad usage.
 */

import { writeFileSync } from "node:fs";
import { isMainModule } from "./is-main-module.mjs";

/** Revision of `-beta.0`; `-beta.N` maps to BETA_BASE + N. */
export const BETA_BASE = 10000;
/** Revision of `-rc.0`; `-rc.N` maps to RC_BASE + N. */
export const RC_BASE = 20000;
/** Revision of the final X.Y.Z release, above every beta and rc. */
export const FINAL_REVISION = 30000;
/** Largest N accepted in `-beta.N` / `-rc.N`. */
export const PRERELEASE_MAX = 9999;

const NUM = "(0|[1-9]\\d*)";
const RELEASE_RE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:([-+])(.*))?$`);
const PRERELEASE_RE = /^(beta|rc)\.(0|[1-9]\d*)$/;

/**
 * @param {string} version - Release version, optionally with a leading `v`.
 * @returns {string} The MSI version `major.minor.patch.revision`.
 * @throws {Error} When the MSI bundler (or this scheme) cannot represent it.
 */
export function msiVersion(version) {
  const raw = String(version).replace(/^v/, "");
  const m = RELEASE_RE.exec(raw);
  if (!m) {
    throw new Error(`'${raw}' is not a release version (expected X.Y.Z[-beta.N|-rc.N])`);
  }
  const [, major, minor, patch, sep, suffix] = m;
  if (Number(major) > 255) throw new Error(`'${raw}': MSI major version cannot exceed 255`);
  if (Number(minor) > 255) throw new Error(`'${raw}': MSI minor version cannot exceed 255`);
  if (Number(patch) > 65535) throw new Error(`'${raw}': MSI patch version cannot exceed 65535`);

  let revision = FINAL_REVISION;
  if (sep !== undefined) {
    const pre = sep === "-" ? PRERELEASE_RE.exec(suffix) : null;
    if (!pre) {
      throw new Error(
        `'${raw}': the only supported prereleases are beta.N or rc.N (no build metadata)`
      );
    }
    const n = Number(pre[2]);
    if (n > PRERELEASE_MAX) {
      throw new Error(`'${raw}': ${pre[1]}.N cannot exceed ${pre[1]}.${PRERELEASE_MAX}`);
    }
    revision = (pre[1] === "beta" ? BETA_BASE : RC_BASE) + n;
  }
  return `${major}.${minor}.${patch}.${revision}`;
}

/**
 * The Tauri `--config` fragment that overrides the MSI version.
 *
 * @param {string} version - Release version, optionally with a leading `v`.
 * @returns {{bundle: {windows: {wix: {version: string}}}}}
 */
export function wixConfigFragment(version) {
  return { bundle: { windows: { wix: { version: msiVersion(version) } } } };
}

function parseArgs(argv) {
  const args = { check: false, configOut: undefined, version: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") {
      args.check = true;
    } else if (a === "--config-out") {
      args.configOut = argv[++i];
      if (args.configOut === undefined) return null;
    } else if (a.startsWith("--") || args.version !== undefined) {
      return null;
    } else {
      args.version = a;
    }
  }
  return args.version === undefined ? null : args;
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write("usage: msi-version.mjs [--check] [--config-out <file>] <version>\n");
    process.exit(2);
  }
  let mapped;
  try {
    mapped = msiVersion(args.version);
  } catch (err) {
    // GitHub Actions annotation; harmless noise when run locally.
    process.stdout.write(
      `::error::Tag v${args.version.replace(/^v/, "")} cannot be built as a Windows MSI: ` +
        `${err.message}. See docs/contributing.md → "Prerelease tags and the Windows MSI version".\n`
    );
    process.exit(1);
  }
  if (args.configOut) {
    writeFileSync(args.configOut, `${JSON.stringify(wixConfigFragment(args.version), null, 2)}\n`);
  }
  if (!args.check) {
    process.stdout.write(`${mapped}\n`);
  }
}
