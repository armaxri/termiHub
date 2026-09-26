#!/usr/bin/env node
// Generate termiHub's third-party notices from the real dependency graph
// (audit finding PKG-009).
//
// The shipped binaries statically link hundreds of Rust crates and the frontend
// bundle carries npm packages. Their licenses (MIT, BSD, Apache-2.0, ...) require
// the copyright notice and license text to accompany the redistributed binary, so
// this script collects the FULL license texts and writes one combined, plain-text
// THIRD_PARTY_NOTICES.txt:
//
//   - Rust: `cargo about generate --format json` over the desktop app
//     (src-tauri), the agent and the workspace-excluded rdp-sidecar, driven by
//     the repo-root about.toml (its `accepted` list mirrors deny.toml's license
//     allowlist). Run `--frozen` after `cargo fetch --locked`, so the result is a
//     pure function of the lockfiles + the pinned cargo-about version.
//   - npm: `pnpm licenses list --prod --json` (production deps only — what ships
//     in the frontend bundle), with each package's own LICENSE/NOTICE files.
//   - External programs: THIRD_PARTY_LICENSES.md (the X servers termiHub
//     installs but does not bundle) plus their texts under licenses/.
//
// Identical license texts are printed once and referenced by number.
//
// The file is generated at release time (release.yml) and bundled into the
// desktop app via the src-tauri/tauri.notices.conf.json fragment; it is not
// committed (it is ~1.3 MB and changes with every dependency bump).
//
// Usage:
//   node scripts/internal/third-party-notices.mjs generate [--out <file>]
//   node scripts/internal/third-party-notices.mjs check
//
//   generate  Write the notices file (default: src-tauri/resources/THIRD_PARTY_NOTICES.txt).
//             Requires cargo-about CARGO_ABOUT_VERSION on PATH (override the binary
//             with the CARGO_ABOUT env var).
//   check     Cheap config gate (no cargo-about, no network): about.toml's accepted
//             list matches deny.toml's allowlist, every npm production dependency
//             has an allowlisted license, and the external-program inputs exist.
//             Rust crate licenses are gated by cargo-deny's `licenses` check.
//
// The pure helpers are exported for unit testing (third-party-notices.test.mjs).

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { NoticesBuilder, compareStrings, spdxAllowed } from "./third-party-notices-model.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The cargo-about version the output is pinned to (keep in sync with release.yml). */
export const CARGO_ABOUT_VERSION = "0.9.2";

/** Default output path; bundled by src-tauri/tauri.notices.conf.json. */
export const DEFAULT_OUT = "src-tauri/resources/THIRD_PARTY_NOTICES.txt";

/** Shipped Rust components, each scanned with its own manifest. */
export const RUST_COMPONENTS = [
  { id: "desktop", manifest: "src-tauri/Cargo.toml" },
  { id: "agent", manifest: "agent/Cargo.toml" },
  { id: "rdp-sidecar", manifest: "rdp-sidecar/Cargo.toml" },
];

/** Lockfile roots that must be fetched before running cargo-about `--frozen`. */
const CARGO_FETCH_MANIFESTS = ["Cargo.toml", "rdp-sidecar/Cargo.toml"];

/** License texts of the external programs documented in THIRD_PARTY_LICENSES.md. */
export const EXTERNAL_TEXTS = [
  {
    file: "licenses/GPL-3.0.txt",
    id: "GPL-3.0-or-later",
    users: ["VcXsrv (installed separately)"],
  },
  { file: "licenses/APSL-2.0.txt", id: "APSL-2.0", users: ["XQuartz (installed separately)"] },
];

/** File names treated as a package's license / notice files. */
const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i;

/**
 * Extract the quoted strings of a top-level TOML array (`key = [ ... ]`),
 * ignoring `#` comments. Optionally restricted to one `[table]`.
 *
 * @param {string} toml - TOML text.
 * @param {string} key - array key, e.g. "allow".
 * @param {string | null} [table] - table name without brackets, or null for the whole file.
 * @returns {string[] | null} the array's strings, or null if the key is absent.
 */
export function tomlStringArray(toml, key, table = null) {
  const lines = toml.split(/\r?\n/).map((line) => line.replace(/#.*$/, ""));
  let inTable = table === null;
  let collecting = false;
  let body = "";
  for (const line of lines) {
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (!collecting && header) {
      inTable = table === null || header[1].trim() === table;
      continue;
    }
    if (!collecting) {
      if (!inTable) continue;
      const m = line.match(new RegExp(`^\\s*${key.replace(/[-]/g, "\\-")}\\s*=\\s*\\[(.*)$`));
      if (!m) continue;
      collecting = true;
      body = m[1];
    } else {
      body += `\n${line}`;
    }
    if (body.includes("]")) {
      const inner = body.slice(0, body.indexOf("]"));
      return [...inner.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    }
  }
  return null;
}

/**
 * Strip the maintainer-only "## Maintenance" section (and the title) from
 * THIRD_PARTY_LICENSES.md so only the attribution content is shipped.
 *
 * @param {string} markdown - THIRD_PARTY_LICENSES.md contents.
 * @returns {string} the attribution body.
 */
export function externalNoticeBody(markdown) {
  const withoutMaintenance = markdown.split(/^## Maintenance\s*$/m)[0];
  return withoutMaintenance.replace(/^# .*\n/, "").replace(/\n-{3,}\s*$/, "");
}

/** Read every license/notice file directly inside a package directory. */
export function readLicenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE_RE.test(name))
    .filter((name) => statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), "utf8") }));
}

/**
 * Flatten `pnpm licenses list --json` output into one record per package version.
 *
 * @param {Record<string, Array<{name: string, versions: string[], paths: string[],
 *   license: string, author?: string}>>} report - pnpm's JSON report.
 * @returns {Array<{name: string, version: string, path: string, license: string}>}
 */
export function flattenPnpmLicenses(report) {
  const out = [];
  for (const entries of Object.values(report)) {
    for (const e of entries) {
      e.versions.forEach((version, i) => {
        out.push({ name: e.name, version, path: e.paths[i] ?? e.paths[0], license: e.license });
      });
    }
  }
  return out.sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.version, b.version));
}

/**
 * Find workflow pins of cargo-about that differ from {@link CARGO_ABOUT_VERSION}.
 *
 * @param {Record<string, string>} workflows - workflow file name -> contents.
 * @returns {string[]} human-readable problems (empty when every pin matches).
 */
export function cargoAboutPinProblems(workflows) {
  const problems = [];
  for (const [file, text] of Object.entries(workflows)) {
    for (const match of text.matchAll(/cargo-about@([^\s'"]+)/g)) {
      if (match[1] !== CARGO_ABOUT_VERSION) {
        problems.push(`${file} pins cargo-about@${match[1]}, expected ${CARGO_ABOUT_VERSION}`);
      }
    }
  }
  return problems;
}

/**
 * Compare about.toml's accepted list with the cargo-deny allowlists.
 *
 * @param {{about: string, deny: string, sidecarDeny: string | null}} files - config texts.
 * @returns {string[]} human-readable problems (empty when consistent).
 */
export function configProblems({ about, deny, sidecarDeny }) {
  const problems = [];
  const accepted = tomlStringArray(about, "accepted");
  const allow = tomlStringArray(deny, "allow", "licenses");
  if (!accepted) problems.push("about.toml has no `accepted` list");
  if (!allow) problems.push("deny.toml has no [licenses] `allow` list");
  if (accepted && allow) {
    const a = new Set(accepted);
    const d = new Set(allow);
    for (const id of d)
      if (!a.has(id)) problems.push(`about.toml accepted is missing "${id}" (in deny.toml)`);
    for (const id of a)
      if (!d.has(id)) problems.push(`about.toml accepts "${id}", which deny.toml does not allow`);
  }
  if (sidecarDeny !== null && accepted) {
    const sidecar = tomlStringArray(sidecarDeny, "allow", "licenses") ?? [];
    const a = new Set(accepted);
    for (const id of sidecar)
      if (!a.has(id))
        problems.push(`about.toml accepted is missing "${id}" (in rdp-sidecar/deny.toml)`);
  }
  return problems;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
    ...opts,
  });
}

function loadPnpmLicenses(root) {
  const json = run("pnpm", ["licenses", "list", "--prod", "--json"], { cwd: root });
  return flattenPnpmLicenses(JSON.parse(json));
}

function readText(root, rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

/** The `check` subcommand. Returns the list of problems. */
export function runCheck(root) {
  const sidecarDenyPath = path.join(root, "rdp-sidecar", "deny.toml");
  const problems = configProblems({
    about: readText(root, "about.toml"),
    deny: readText(root, "deny.toml"),
    sidecarDeny: existsSync(sidecarDenyPath) ? readFileSync(sidecarDenyPath, "utf8") : null,
  });
  for (const { file } of EXTERNAL_TEXTS) {
    if (!existsSync(path.join(root, file))) problems.push(`missing external license text ${file}`);
  }
  if (!existsSync(path.join(root, "THIRD_PARTY_LICENSES.md")))
    problems.push("missing THIRD_PARTY_LICENSES.md");
  const workflowDir = path.join(root, ".github", "workflows");
  if (existsSync(workflowDir)) {
    const workflows = Object.fromEntries(
      readdirSync(workflowDir)
        .filter((name) => name.endsWith(".yml"))
        .map((name) => [name, readFileSync(path.join(workflowDir, name), "utf8")])
    );
    problems.push(...cargoAboutPinProblems(workflows));
  }

  const allowed = new Set(tomlStringArray(readText(root, "deny.toml"), "allow", "licenses") ?? []);
  const packages = loadPnpmLicenses(root);
  for (const pkg of packages) {
    if (!spdxAllowed(pkg.license, allowed)) {
      problems.push(
        `npm ${pkg.name}@${pkg.version}: license "${pkg.license}" is not in deny.toml's allowlist`
      );
    }
  }
  console.log(
    `Checked ${packages.length} npm production packages against ${allowed.size} allowed licenses.`
  );
  return problems;
}

/** The `generate` subcommand. Returns {out, bytes, missing}. */
export function runGenerate(root, outRel) {
  const cargoAbout = process.env.CARGO_ABOUT || "cargo-about";
  let versionLine;
  try {
    versionLine = run(cargoAbout, ["--version"]).trim();
  } catch {
    throw new Error(
      `cargo-about not found. Install the pinned version: cargo install cargo-about --locked --version ${CARGO_ABOUT_VERSION}`
    );
  }
  if (versionLine !== `cargo-about ${CARGO_ABOUT_VERSION}`) {
    throw new Error(`expected cargo-about ${CARGO_ABOUT_VERSION}, found "${versionLine}"`);
  }

  const problems = runCheck(root);
  if (problems.length > 0) throw new Error(`config check failed:\n  ${problems.join("\n  ")}`);

  for (const manifest of CARGO_FETCH_MANIFESTS) {
    run("cargo", ["fetch", "--locked", "--manifest-path", path.join(root, manifest)], {
      cwd: root,
    });
  }

  const builder = new NoticesBuilder();
  for (const { id, manifest } of RUST_COMPONENTS) {
    console.log(`cargo-about: ${id} (${manifest})`);
    const json = run(
      cargoAbout,
      [
        "generate",
        "--format",
        "json",
        "--frozen",
        "--fail",
        "--config",
        path.join(root, "about.toml"),
        "--manifest-path",
        path.join(root, manifest),
      ],
      { cwd: root }
    );
    builder.addCargoAbout(id, JSON.parse(json));
  }

  for (const pkg of loadPnpmLicenses(root)) {
    builder.addNpm({ ...pkg, files: readLicenseFiles(pkg.path) });
  }
  for (const { file, id, users } of EXTERNAL_TEXTS) {
    for (const user of users) builder.addText(readText(root, file), id, user);
  }
  builder.resolveMissingNpmTexts();

  const version = JSON.parse(readText(root, "package.json")).version;
  const text = builder.render({
    version,
    externalNotice: externalNoticeBody(readText(root, "THIRD_PARTY_LICENSES.md")),
  });
  const out = path.resolve(root, outRel);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, text);
  return {
    out,
    bytes: Buffer.byteLength(text),
    crates: builder.crates.size,
    npm: builder.npm.size,
    texts: builder.texts.size,
    missing: builder.missing,
  };
}

function main(argv) {
  const [command, ...rest] = argv;
  let root = DEFAULT_ROOT;
  let out = DEFAULT_OUT;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--root") root = path.resolve(rest[++i]);
    else if (rest[i] === "--out") out = rest[++i];
    else {
      console.error(`unknown argument: ${rest[i]}`);
      return 2;
    }
  }

  if (command === "check") {
    const problems = runCheck(root);
    if (problems.length > 0) {
      for (const p of problems) console.error(`error: ${p}`);
      return 1;
    }
    console.log("Third-party license config OK.");
    return 0;
  }
  if (command === "generate") {
    try {
      const r = runGenerate(root, out);
      console.log(
        `Wrote ${r.out} (${r.bytes} bytes): ${r.crates} crates, ${r.npm} npm packages, ${r.texts} license texts.`
      );
      if (r.missing.length > 0) {
        for (const m of r.missing) console.error(`error: no license text for ${m}`);
        return 1;
      }
      return 0;
    } catch (err) {
      console.error(`error: ${err.message}`);
      return 1;
    }
  }
  console.error("usage: third-party-notices.mjs <generate [--out <file>] | check> [--root <dir>]");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
