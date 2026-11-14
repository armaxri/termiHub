#!/usr/bin/env node
// Keep the privacy notice honest (#5759).
//
// PRIVACY.md (repo root) is a short summary that links the full notice,
// docs/privacy.md. Settings ▸ About opens the full notice on GitHub. This check
// fails when:
//
//  1. a relative link in either file points at a file that does not exist, or at
//     a `#heading` the target file does not have;
//  2. the About page's privacy URL names a repo path that does not exist;
//  3. an endpoint termiHub contacts on its own (ENDPOINTS: update check, in-app
//     updater manifest, agent downloads, plugin index) is not named in
//     docs/privacy.md, or its source constant can no longer be found;
//  4. a production Rust file outside HTTP_CLIENT_FILES starts using `reqwest`,
//     so a new outbound connection cannot land without someone reviewing the
//     notice.
//
// Usage: node scripts/internal/check-privacy-notice.mjs [--root <repo-dir>]

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SUMMARY_FILE = "PRIVACY.md";
export const NOTICE_FILE = "docs/privacy.md";
export const ABOUT_FILE = "src/components/Settings/AboutSettings.tsx";

/** The repository every `{repo}` / `{GITHUB_REPO}` placeholder stands for. */
const REPO = "armaxri/termiHub";

/**
 * Endpoints termiHub contacts on its own. `pattern` captures the URL from the
 * source file; the URL (scheme dropped, cut at the first remaining placeholder)
 * must appear in docs/privacy.md.
 */
export const ENDPOINTS = [
  {
    what: "stable update check",
    file: "src-tauri/src/commands/update.rs",
    pattern: /GITHUB_API_URL: &str = "([^"]+)"/,
  },
  {
    what: "develop update check",
    file: "src-tauri/src/commands/update_develop.rs",
    pattern: /DEVELOP_RELEASE_API_URL: &str =\s*"([^"]+)"/,
  },
  {
    what: "in-app updater manifest",
    file: "src-tauri/tauri.updater.conf.json",
    pattern: /"endpoints":\s*\["([^"]+)"/,
  },
  {
    what: "agent binary download",
    file: "src-tauri/src/terminal/agent_binary.rs",
    pattern: /fn download_dir_url[\s\S]*?format!\("([^"]+)"/,
  },
  {
    what: "plugin index",
    file: "src-tauri/src/commands/plugin_index.rs",
    pattern: /DEFAULT_PLUGIN_INDEX_URL: &str =\s*"([^"]+)"/,
  },
  {
    what: "agent self-update check",
    file: "agent/src/update/github.rs",
    pattern: /format!\("(https:\/\/api\.github\.com\/[^"]+)"/,
  },
];

/**
 * Production Rust files allowed to use `reqwest`, each covered by the notice.
 * A new HTTP client user must be described in docs/privacy.md and added here.
 */
export const HTTP_CLIENT_FILES = [
  "agent/src/update/download.rs", // agent self-update download (off by default)
  "agent/src/update/github.rs", // agent self-update check (off by default)
  "agent/src/update/mod.rs", // agent self-update client
  "core/src/monitoring/http_monitor.rs", // HTTP monitor: user-entered address
  "core/src/monitoring/mod.rs", // comment only
  "rdp-sidecar/src/rdp.rs", // RDP NLA (Kerberos) during sign-in
  "src-tauri/src/commands/plugin_fetch.rs", // plugin index / package / update fetches
  "src-tauri/src/commands/plugin_index.rs", // plugin index
  "src-tauri/src/commands/update.rs", // update check
  "src-tauri/src/lib.rs", // comment only (HTTP monitor shutdown)
  "src-tauri/src/network/mod.rs", // comment only (HTTP monitor cancel)
  "src-tauri/src/utils/download.rs", // agent binary download
  "src-tauri/src/utils/test_bridge.rs", // test-bridge builds only
];

/** Rust source roots scanned for `reqwest` users. */
const RUST_ROOTS = [
  "src-tauri/src",
  "core/src",
  "agent/src",
  "plugin-runner/src",
  "rdp-sidecar/src",
];

/**
 * GitHub's heading anchor for a Markdown heading text.
 *
 * @param {string} heading - the heading text without the leading `#`s.
 * @returns {string}
 */
export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * Anchors of every heading in a Markdown text (outside code fences).
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function headingAnchors(text) {
  const anchors = new Set();
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) anchors.add(slugify(m[1]));
  }
  return anchors;
}

/**
 * Inline Markdown link targets in a text, skipping code spans and fences.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function linkTargets(text) {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
}

/**
 * Check every relative link in `file`.
 *
 * @param {string} root - repository root.
 * @param {string} file - repo-relative Markdown file.
 * @returns {string[]} problems.
 */
export function checkLinks(root, file) {
  const abs = path.join(root, file);
  if (!existsSync(abs)) return [`${file}: missing`];
  const text = readFileSync(abs, "utf8");
  const problems = [];
  for (const target of linkTargets(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:, …
    const [rel, anchor] = target.split("#");
    const targetFile = rel === "" ? abs : path.resolve(path.dirname(abs), decodeURI(rel));
    const shown = rel === "" ? `#${anchor}` : target;
    if (!existsSync(targetFile)) {
      problems.push(`${file}: link "${shown}" points at a missing file`);
      continue;
    }
    if (anchor === undefined || statSync(targetFile).isDirectory()) continue;
    if (!headingAnchors(readFileSync(targetFile, "utf8")).has(anchor)) {
      problems.push(`${file}: link "${shown}" names a heading that does not exist`);
    }
  }
  return problems;
}

/**
 * Check that the About page's privacy URL names an existing repo file.
 *
 * @param {string} root - repository root.
 * @returns {string[]} problems.
 */
export function checkAboutLink(root) {
  const text = readFileSync(path.join(root, ABOUT_FILE), "utf8");
  const m = /PRIVACY_URL = "https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/[^/]+\/([^"#]+)"/.exec(
    text
  );
  if (!m) return [`${ABOUT_FILE}: no PRIVACY_URL pointing at a file in the repository`];
  const problems = [];
  if (m[1] !== REPO) problems.push(`${ABOUT_FILE}: PRIVACY_URL names ${m[1]}, not ${REPO}`);
  if (!existsSync(path.join(root, m[2]))) {
    problems.push(`${ABOUT_FILE}: PRIVACY_URL points at ${m[2]}, which does not exist`);
  }
  return problems;
}

/**
 * The part of an endpoint URL the notice must name: no scheme, placeholders
 * for the repository filled in, cut at the first remaining placeholder.
 *
 * @param {string} url
 * @returns {string}
 */
export function endpointText(url) {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/\{(?:repo|GITHUB_REPO)\}/g, REPO)
    .split("{")[0];
}

/**
 * Check that every endpoint is found in its source and named in the notice.
 *
 * @param {string} root - repository root.
 * @param {string} notice - docs/privacy.md text.
 * @param {typeof ENDPOINTS} [endpoints]
 * @returns {string[]} problems.
 */
export function checkEndpoints(root, notice, endpoints = ENDPOINTS) {
  const problems = [];
  for (const { what, file, pattern } of endpoints) {
    const abs = path.join(root, file);
    const m = existsSync(abs) ? pattern.exec(readFileSync(abs, "utf8")) : null;
    if (!m) {
      problems.push(
        `${what}: endpoint not found in ${file}; update ENDPOINTS in check-privacy-notice.mjs`
      );
      continue;
    }
    const needle = endpointText(m[1]);
    if (!notice.includes(needle)) {
      problems.push(`${what}: ${NOTICE_FILE} does not name "${needle}" (from ${file})`);
    }
  }
  return problems;
}

/** Recursively list `.rs` files under `dir` (repo-relative, `/`-separated). */
function rustFiles(root, dir) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...rustFiles(root, rel));
    else if (entry.name.endsWith(".rs")) out.push(rel);
  }
  return out;
}

/** Whether a Rust file is test-only by name. */
function isTestFile(file) {
  return /(_tests?|\/tests?)\.rs$/.test(file) || /\/tests\//.test(file);
}

/**
 * Check that only the reviewed files use `reqwest`.
 *
 * @param {string} root - repository root.
 * @returns {string[]} problems.
 */
export function checkHttpClients(root) {
  const allowed = new Set(HTTP_CLIENT_FILES);
  const problems = [];
  for (const dir of RUST_ROOTS) {
    for (const file of rustFiles(root, dir)) {
      if (isTestFile(file) || allowed.has(file)) continue;
      if (/\breqwest\b/.test(readFileSync(path.join(root, file), "utf8"))) {
        problems.push(
          `${file} uses reqwest: describe the connection in ${NOTICE_FILE}, then add the file ` +
            "to HTTP_CLIENT_FILES in scripts/internal/check-privacy-notice.mjs"
        );
      }
    }
  }
  return problems;
}

/**
 * Run every check.
 *
 * @param {string} root - repository root.
 * @returns {string[]} problems.
 */
export function checkRepo(root) {
  const noticePath = path.join(root, NOTICE_FILE);
  if (!existsSync(noticePath)) return [`${NOTICE_FILE}: missing`];
  const notice = readFileSync(noticePath, "utf8");
  return [
    ...checkLinks(root, SUMMARY_FILE),
    ...checkLinks(root, NOTICE_FILE),
    ...checkAboutLink(root),
    ...checkEndpoints(root, notice),
    ...checkHttpClients(root),
  ];
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const problems = checkRepo(root);
  if (problems.length > 0) {
    console.error("Privacy notice problems (see scripts/internal/check-privacy-notice.mjs):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `${SUMMARY_FILE} and ${NOTICE_FILE} links resolve and the notice names every endpoint.`
  );
}
