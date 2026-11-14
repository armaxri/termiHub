#!/usr/bin/env node
// Write and check the in-app updater manifest `latest.json` (#5758).
//
// Every installed termiHub reads
// https://github.com/armaxri/termiHub/releases/latest/download/latest.json
// (`plugins.updater.endpoints` in src-tauri/tauri.updater.conf.json) to find
// its update. A wrong manifest breaks updating for every installed copy until
// the next release, so release.yml writes it from the signed bundles and checks
// it before anything is uploaded:
//
//   write  Build latest.json from the staged bundles and their `.sig` files.
//   check  Check a latest.json against the bundles: the version is the release
//          version; every published target (updater-platforms.json) is there;
//          each url is the release download URL of that target's bundle; each
//          signature is the bundle's `.sig`, verifies against the public key in
//          the release config and is bound to the release version (minisign
//          trusted comment `version:<v>`, what `requireSignedVersion` checks).
//
//   assets List the published updater bundle names of a version, one per line
//          (what the sign-updater job signs, #5761).
//   verify Verify each bundle's `.sig` in a directory against the configured key
//          and the signed version, without a latest.json (sign-updater's self-check).
//
// `write` runs `check` on what it wrote. All of them read only local files.
//
// The idea of a release-time manifest check comes from browsitory
// (github.com/rene-langer/browsitory, MIT, scripts/check-updater-manifest.py);
// this is an independent implementation for termiHub's own asset layout, and it
// additionally verifies each signature against the public key.
//
// Usage:
//   node scripts/internal/updater-manifest.mjs write --version X.Y.Z --dir DIR
//       [--notes-file FILE] [--pub-date ISO] [--config tauri.updater.conf.json]
//   node scripts/internal/updater-manifest.mjs check --version X.Y.Z --dir DIR
//       [--config tauri.updater.conf.json]
//   Both take [--signed-version V]: the version the bundles were signed for
//   (default --version). A release dry run names its assets 0.0.0-dryrun while
//   the app inside still carries the tauri.conf.json version it was signed for.
//   node scripts/internal/updater-manifest.mjs pubkey [--config FILE]
//       prints the configured public key (empty when none is set up yet)
//   node scripts/internal/updater-manifest.mjs assets --version X.Y.Z
//   node scripts/internal/updater-manifest.mjs verify --version X.Y.Z --dir DIR
//       [--signed-version V] [--config FILE]
//
// Exit status: 0 ok, 1 the manifest or a signature is wrong, 2 bad arguments.

import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
export const PLATFORMS_FILE = path.join(HERE, "updater-platforms.json");
export const DEFAULT_CONFIG = path.join(ROOT, "src-tauri", "tauri.updater.conf.json");

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The published updater platforms (`updater-platforms.json`). */
export function loadPlatforms(file = PLATFORMS_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The public key (`plugins.updater.pubkey`) of a Tauri config file, or "". */
export function configuredPubkey(configFile = DEFAULT_CONFIG) {
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const key = config?.plugins?.updater?.pubkey;
  return typeof key === "string" ? key.trim() : "";
}

/** Fill `{version}` in a platforms.json template. */
const fill = (template, version) => template.replaceAll("{version}", version);

/** The non-comment lines of a base64-wrapped minisign file. */
function minisignLines(base64Text, what) {
  let text;
  try {
    text = Buffer.from(base64Text.trim(), "base64").toString("utf8");
  } catch {
    throw new Error(`${what} is not base64`);
  }
  return text.split(/\r?\n/).filter((l) => l.length > 0);
}

/**
 * Parse a Tauri public key (base64 of a minisign public key file).
 * @returns {{ keyId: Buffer, key: import("node:crypto").KeyObject }}
 */
export function parsePublicKey(pubkeyBase64) {
  const lines = minisignLines(pubkeyBase64, "public key");
  const raw = Buffer.from(lines.find((l) => !l.startsWith("untrusted comment:")) ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("public key is not a minisign Ed25519 key");
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]),
    format: "der",
    type: "spki",
  });
  return { keyId: raw.subarray(2, 10), key };
}

/**
 * Verify a Tauri `.sig` (base64 of a minisign signature file) over `data`.
 * Returns the trusted comment's fields; throws when anything does not verify.
 */
export function verifySignature(sigBase64, data, pubkeyBase64) {
  const { keyId, key } = parsePublicKey(pubkeyBase64);
  const lines = minisignLines(sigBase64, "signature");
  const [, sigLine, trustedLine, globalLine] = lines;
  if (!sigLine || !trustedLine?.startsWith("trusted comment: ") || !globalLine) {
    throw new Error("signature is not a minisign signature file");
  }
  const sig = Buffer.from(sigLine, "base64");
  if (sig.length !== 74) throw new Error("signature has the wrong length");
  const alg = sig.subarray(0, 2).toString("latin1");
  if (alg !== "ED" && alg !== "Ed") throw new Error(`unknown signature algorithm ${alg}`);
  if (!sig.subarray(2, 10).equals(keyId)) {
    throw new Error("signature was made by a different key than the configured public key");
  }
  const signed = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, signed, key, sig.subarray(10))) {
    throw new Error("signature does not match the file");
  }
  const trusted = trustedLine.slice("trusted comment: ".length);
  const global = Buffer.from(globalLine, "base64");
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted, "utf8")]), key, global)) {
    throw new Error("trusted comment signature does not verify");
  }
  return Object.fromEntries(
    trusted.split("\t").map((field) => {
      const at = field.indexOf(":");
      return at < 0 ? [field, ""] : [field.slice(0, at), field.slice(at + 1)];
    })
  );
}

/** Read `name` from `dir`, or null when it is missing. */
function readAsset(dir, name, encoding) {
  const file = path.join(dir, name);
  return existsSync(file) ? readFileSync(file, encoding) : null;
}

/** The published updater bundle names of release `version`. */
export function assetNames(platforms, version) {
  return platforms.platforms.map((p) => fill(p.asset, version));
}

/**
 * The problem with one bundle's `.sig` in `dir` (missing, not verifying against
 * `pubkey`, or bound to a version other than `signedVersion`), or null.
 */
function signatureProblem({ dir, asset, pubkey, signedVersion, sig }) {
  const data = readAsset(dir, asset);
  if (sig === null || data === null) return `${asset} or its .sig is not in ${dir}`;
  try {
    const fields = verifySignature(sig, data, pubkey);
    if (fields.version !== signedVersion) {
      return `signed for version ${JSON.stringify(fields.version)}, expected "${signedVersion}"`;
    }
  } catch (err) {
    return err.message;
  }
  return null;
}

/**
 * Every problem with the `.sig` files of release `version` in `dir`, or []:
 * each published bundle is there with a `.sig` that verifies against `pubkey`
 * and is bound to `signedVersion`.
 */
export function signatureProblems({ version, dir, pubkey, platforms, signedVersion = version }) {
  const problems = [];
  for (const p of platforms.platforms) {
    const asset = fill(p.asset, version);
    const sig = readAsset(dir, `${asset}.sig`, "utf8");
    const problem = signatureProblem({ dir, asset, pubkey, signedVersion, sig });
    if (problem) problems.push(`${p.target}: ${problem}`);
  }
  return problems;
}

/**
 * Every problem with `manifest` for release `version`, or [] when there is
 * none. `dir` holds the bundles and their `.sig` files under their published
 * names.
 */
export function manifestProblems({
  manifest,
  version,
  dir,
  pubkey,
  platforms,
  signedVersion = version,
}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["latest.json is not a JSON object"];
  }
  const problems = [];
  if (manifest.version !== version) {
    problems.push(`version is ${JSON.stringify(manifest.version)}, expected "${version}"`);
  }
  const entries = manifest.platforms;
  if (!entries || typeof entries !== "object") {
    return [...problems, "latest.json has no platforms object"];
  }
  const known = new Set(platforms.platforms.map((p) => p.target));
  for (const target of Object.keys(entries)) {
    if (!known.has(target)) problems.push(`${target}: not a published updater target`);
  }
  for (const p of platforms.platforms) {
    const entry = entries[p.target];
    if (!entry) {
      problems.push(`${p.target}: missing`);
      continue;
    }
    const asset = fill(p.asset, version);
    const url = fill(platforms.downloadBase, version) + encodeURIComponent(asset);
    if (entry.url !== url) problems.push(`${p.target}: url is ${entry.url}, expected ${url}`);
    const sig = readAsset(dir, `${asset}.sig`, "utf8");
    if (sig !== null && readAsset(dir, asset) !== null) {
      if (typeof entry.signature !== "string" || entry.signature.trim() !== sig.trim()) {
        problems.push(`${p.target}: signature differs from ${asset}.sig`);
        continue;
      }
    }
    const problem = signatureProblem({ dir, asset, pubkey, signedVersion, sig });
    if (problem) problems.push(`${p.target}: ${problem}`);
  }
  return problems;
}

/** Build the manifest for `version` from the `.sig` files in `dir`. */
export function buildManifest({ version, dir, platforms, notes = "", pubDate }) {
  const entries = {};
  for (const p of platforms.platforms) {
    const asset = fill(p.asset, version);
    const sig = readAsset(dir, `${asset}.sig`, "utf8");
    if (sig === null) throw new Error(`${asset}.sig is not in ${dir}`);
    entries[p.target] = {
      signature: sig.trim(),
      url: fill(platforms.downloadBase, version) + encodeURIComponent(asset),
    };
  }
  return { version, notes, pub_date: pubDate, platforms: entries };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, config: DEFAULT_CONFIG };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    const keys = {
      "--version": "version",
      "--dir": "dir",
      "--notes-file": "notesFile",
      "--pub-date": "pubDate",
      "--config": "config",
      "--signed-version": "signedVersion",
    };
    if (!(flag in keys) || value === undefined) throw new Error(`unknown or incomplete ${flag}`);
    opts[keys[flag]] = value;
    i += 1;
  }
  if (!["write", "check", "verify", "assets", "pubkey"].includes(command)) {
    throw new Error("command must be write, check, verify, assets or pubkey");
  }
  if (command !== "pubkey") {
    if (!opts.version || !VERSION_RE.test(opts.version)) {
      throw new Error("--version X.Y.Z is required");
    }
    if (command !== "assets" && !opts.dir) throw new Error("--dir is required");
  }
  return opts;
}

/** CLI entry point; returns the exit status. */
export function main(argv, out = console) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    out.error(`updater-manifest: ${err.message}`);
    return 2;
  }
  const platforms = loadPlatforms();
  if (opts.command === "assets") {
    for (const name of assetNames(platforms, opts.version)) out.log(name);
    return 0;
  }
  const pubkey = configuredPubkey(opts.config);
  if (opts.command === "pubkey") {
    out.log(pubkey);
    return 0;
  }
  if (!pubkey) {
    out.error(`updater-manifest: no updater public key in ${opts.config}`);
    return 1;
  }
  const signedVersion = opts.signedVersion ?? opts.version;
  if (opts.command === "verify") {
    const problems = signatureProblems({
      version: opts.version,
      dir: opts.dir,
      pubkey,
      platforms,
      signedVersion,
    });
    if (problems.length > 0) {
      out.error(`updater signatures of ${opts.version} do not verify:`);
      for (const problem of problems) out.error(`  ${problem}`);
      return 1;
    }
    out.log(
      `${platforms.platforms.length} updater bundles of ${opts.version}: each .sig verifies ` +
        `against the configured key and is bound to version ${signedVersion}`
    );
    return 0;
  }
  const manifestFile = path.join(opts.dir, "latest.json");
  try {
    if (opts.command === "write") {
      const notes = opts.notesFile ? readFileSync(opts.notesFile, "utf8").trim() : "";
      const manifest = buildManifest({
        version: opts.version,
        dir: opts.dir,
        platforms,
        notes,
        pubDate: opts.pubDate ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
      writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const problems = manifestProblems({
      manifest,
      version: opts.version,
      dir: opts.dir,
      pubkey,
      platforms,
      signedVersion,
    });
    if (problems.length > 0) {
      out.error(`latest.json of ${opts.version} is not right:`);
      for (const problem of problems) out.error(`  ${problem}`);
      return 1;
    }
  } catch (err) {
    out.error(`updater-manifest: ${err.message}`);
    return 1;
  }
  out.log(
    `latest.json of ${opts.version}: ${platforms.platforms.length} targets, each linked to its ` +
      "release bundle and signed for this version with the configured key"
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
