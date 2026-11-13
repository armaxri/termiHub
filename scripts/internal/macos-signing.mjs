#!/usr/bin/env node
// Designated-requirement checks for termiHub's stable macOS signing identity (#5545).
//
// macOS ties an app's keychain access to its *designated requirement* (DR): the
// keychain item's access list stores the DR of the app that wrote it, and only
// code satisfying that DR reads it without a prompt.
//   - An ad-hoc signature has no certificate, so its DR is the build hash
//     (`cdhash H"..."`). Every release has a new one, so every update loses
//     access to the passwords the previous release saved.
//   - Code signed by a certificate gets `identifier "<id>" and certificate
//     root = H"<sha1>"` (a self-signed certificate is its own root; a chained
//     one may read `certificate leaf`). Every build signed by the same
//     certificate has the SAME DR, so saved passwords keep working.
//
// This module parses `codesign -d -r-` output and checks that a signature
// carries the pinned identity, so release.yml and the one-time setup script
// (setup-macos-signing-identity.sh) can prove the DR before anything ships.
// The pinned certificate lives in macos-signing-identity.json (public data:
// the SHA-1 the DR names, plus the subject for humans).
//
// CLI (macOS: runs `codesign -d -r- <path>` itself):
//   node scripts/internal/macos-signing.mjs pinned
//       Print the pinned certificate SHA-1 ("" while none is set up).
//   node scripts/internal/macos-signing.mjs check --cert-sha1 <hex>
//       [--identifier <id>] <path>...
//       Exit 1 unless every <path> is signed by that certificate (and, with
//       --identifier, under that identifier).
//   node scripts/internal/macos-signing.mjs same <path> <path>...
//       Exit 1 unless every <path> has the same certificate-based DR. Ad-hoc
//       signatures fail: their DR is the build hash and never matches.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Committed public pin of the signing certificate. */
export const PIN_FILE = path.join(HERE, "macos-signing-identity.json");

const SHA1_RE = /^[0-9a-f]{40}$/;

/**
 * Normalise a certificate SHA-1 as printed by openssl (`AB:CD:...`),
 * `security find-identity` (upper-case hex) or codesign (lower-case hex).
 *
 * @param {string} value
 * @returns {string} 40 lower-case hex digits
 */
export function normalizeSha1(value) {
  const hex = String(value ?? "")
    .replace(/^sha1\s*fingerprint\s*=\s*/i, "")
    .replace(/[:\s]/g, "")
    .toLowerCase();
  if (!SHA1_RE.test(hex)) {
    throw new Error(`not a certificate SHA-1: ${JSON.stringify(value)}`);
  }
  return hex;
}

/**
 * Extract the designated requirement from `codesign -d -r- <path>` output
 * (stdout and stderr together). An ad-hoc signature prints its implicit DR as
 * a comment (`# designated => cdhash H"..."`); that is returned as well, so
 * the caller can name it.
 *
 * @param {string} output
 * @returns {string | null} the requirement text, or null when none is printed
 */
export function extractDesignatedRequirement(output) {
  for (const line of String(output).split(/\r?\n/)) {
    const m = /^\s*(?:#\s*)?designated\s*=>\s*(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * Parse a designated requirement into the parts this project cares about.
 *
 * @param {string} requirement e.g. `identifier "com.termihub.app" and certificate root = H"<sha1>"`
 * @returns {{kind: "certificate", identifier: string | null, slot: "leaf" | "root", certSha1: string}
 *   | {kind: "cdhash", cdhash: string}
 *   | {kind: "other", requirement: string}}
 */
export function parseRequirement(requirement) {
  const text = String(requirement).trim();
  const cdhash = /^cdhash\s+H"([0-9a-fA-F]+)"$/.exec(text);
  if (cdhash) return { kind: "cdhash", cdhash: cdhash[1].toLowerCase() };
  // The whole DR must be exactly "[identifier X and] certificate leaf|root = H"…"",
  // so a DR that adds or swaps clauses (anchor apple, a team id) is "other".
  const cert =
    /^(?:identifier\s+(?:"([^"]+)"|([^\s"]+))\s+and\s+)?certificate\s+(leaf|root)\s*=\s*H"([0-9a-fA-F]{40})"$/.exec(
      text
    );
  if (cert) {
    return {
      kind: "certificate",
      identifier: cert[1] ?? cert[2] ?? null,
      slot: /** @type {"leaf" | "root"} */ (cert[3]),
      certSha1: cert[4].toLowerCase(),
    };
  }
  return { kind: "other", requirement: text };
}

/**
 * Check one `codesign -d -r-` output against the pinned certificate.
 *
 * @param {string} output codesign output
 * @param {{certSha1: string, identifier?: string, label?: string}} expected
 * @returns {string} the designated requirement (for logging)
 * @throws {Error} naming what is wrong (ad hoc, another certificate, wrong identifier)
 */
export function checkDesignatedRequirement(output, expected) {
  const label = expected.label ?? "binary";
  const want = normalizeSha1(expected.certSha1);
  const requirement = extractDesignatedRequirement(output);
  if (requirement === null) {
    throw new Error(`${label}: codesign printed no designated requirement (unsigned?)`);
  }
  const dr = parseRequirement(requirement);
  if (dr.kind === "cdhash") {
    throw new Error(
      `${label}: ad-hoc signature (designated requirement is the build hash ${dr.cdhash}); ` +
        "keychain access would not survive an update"
    );
  }
  if (dr.kind !== "certificate") {
    throw new Error(`${label}: unexpected designated requirement: ${dr.requirement}`);
  }
  if (dr.certSha1 !== want) {
    throw new Error(`${label}: signed by certificate ${dr.certSha1}, expected the pinned ${want}`);
  }
  if (expected.identifier !== undefined && dr.identifier !== expected.identifier) {
    throw new Error(
      `${label}: signing identifier ${JSON.stringify(dr.identifier)}, expected ${JSON.stringify(expected.identifier)}`
    );
  }
  return requirement;
}

/**
 * Check that several signatures share one certificate-based DR. This is the
 * property that keeps keychain access across updates: two builds with
 * different code (different cdhash, different signing time) signed by the same
 * identity under the same identifier must yield the same requirement.
 *
 * @param {{label: string, output: string}[]} signatures
 * @returns {string} the shared requirement
 */
export function checkSameRequirement(signatures) {
  if (signatures.length < 2) throw new Error("need at least two signatures to compare");
  let first = null;
  for (const { label, output } of signatures) {
    const requirement = extractDesignatedRequirement(output);
    if (requirement === null) throw new Error(`${label}: no designated requirement`);
    const dr = parseRequirement(requirement);
    if (dr.kind !== "certificate") {
      throw new Error(`${label}: not certificate-based (${requirement})`);
    }
    if (first === null) {
      first = { label, requirement };
    } else if (requirement !== first.requirement) {
      throw new Error(
        `designated requirements differ:\n  ${first.label}: ${first.requirement}\n  ${label}: ${requirement}`
      );
    }
  }
  return first.requirement;
}

/**
 * Read the pinned certificate SHA-1.
 *
 * @param {string} [file]
 * @returns {string} 40 lower-case hex digits, or "" while no identity is set up
 */
export function readPinned(file = PIN_FILE) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const value = String(data.certificateSha1 ?? "");
  return value === "" ? "" : normalizeSha1(value);
}

function codesignRequirement(target) {
  // codesign writes "Executable=..." to stderr and the DR to stdout.
  try {
    return execFileSync("codesign", ["-d", "-r-", target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      `codesign -d -r- ${target} failed: ${String(err.stderr ?? err.message).trim()}`
    );
  }
}

/**
 * Run the CLI.
 *
 * @param {string[]} args
 * @param {(target: string) => string} [readRequirement] injectable for tests
 * @returns {string} text for stdout
 */
export function runCli(args, readRequirement = codesignRequirement) {
  const [command, ...rest] = args;
  if (command === "pinned") {
    if (rest.length > 0) throw new Error("pinned takes no arguments");
    return `${readPinned()}\n`;
  }
  if (command === "check") {
    let certSha1;
    let identifier;
    const targets = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--cert-sha1") certSha1 = rest[++i];
      else if (rest[i] === "--identifier") identifier = rest[++i];
      else if (rest[i].startsWith("--")) throw new Error(`unknown option: ${rest[i]}`);
      else targets.push(rest[i]);
    }
    if (!certSha1) throw new Error("check needs --cert-sha1 <hex>");
    if (targets.length === 0) throw new Error("check needs at least one path");
    return targets
      .map((target) => {
        const dr = checkDesignatedRequirement(readRequirement(target), {
          certSha1,
          identifier,
          label: target,
        });
        return `ok  ${target}: ${dr}\n`;
      })
      .join("");
  }
  if (command === "same") {
    const requirement = checkSameRequirement(
      rest.map((target) => ({ label: target, output: readRequirement(target) }))
    );
    return `ok  ${rest.length} signatures share: ${requirement}\n`;
  }
  throw new Error(`unknown command: ${command ?? "(none)"} (expected pinned, check or same)`);
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(runCli(process.argv.slice(2)));
  } catch (err) {
    console.error(`macos-signing: ${err.message}`);
    process.exit(1);
  }
}
