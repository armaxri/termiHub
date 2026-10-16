#!/usr/bin/env node
// Keep every cargo tool CI installs via taiki-e/install-action pinned to ONE
// version (#4406).
//
// Single source of truth: `.github/cargo-tools.json`, a `tools` map of
// `<name>: "X.Y.Z"`. The action itself is SHA-pinned (check-action-pins.mjs),
// but a bare `tool: cargo-deny` installs whatever release is newest on the
// day, so an upstream release could change a gate with no commit here, and the
// post-merge Security Audit and the release gate could run different
// cargo-deny/cargo-audit versions. This check fails if:
//
//   1. `.github/cargo-tools.json` is missing, not JSON, or holds a tool whose
//      version is not an exact X.Y.Z;
//   2. a taiki-e/install-action step in a workflow or composite action uses the
//      `@<tool>` shorthand ref, has no literal `tool:` input, or lists a tool
//      without `@X.Y.Z`;
//   3. a listed tool is missing from the pin file or pinned to another version;
//   4. a tool in the pin file is installed nowhere (a stale pin).
//
// Sibling of check-cross-version.mjs and check-uv-version.mjs.
// Bump procedure: docs/contributing.md -> "Cargo tool versions".
//
// Usage: node scripts/internal/check-cargo-tool-pins.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-cargo-tool-pins.test.mjs).

import { existsSync, readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The pin file, relative to the repo root. */
export const PIN_FILE = ".github/cargo-tools.json";

/** `uses: taiki-e/install-action@<ref>` (optionally as a `- uses:` list item). */
const USES_INSTALL_ACTION = /^(\s*)(-\s+)?uses:\s*['"]?taiki-e\/install-action@([^\s'"#]+)/;
/** A full 40-hex commit SHA ref. */
const SHA_REF = /^[0-9a-f]{40}$/;
/** An exact version. */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Parse the pin file's contents.
 *
 * @param {string | null | undefined} text - contents of `.github/cargo-tools.json`.
 * @returns {{ pins: Record<string, string> | null, problems: string[] }}
 */
export function parsePins(text) {
  if (typeof text !== "string") return { pins: null, problems: [`${PIN_FILE} not found`] };
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { pins: null, problems: [`${PIN_FILE} is not valid JSON: ${err.message}`] };
  }
  const tools = data?.tools;
  if (tools === null || typeof tools !== "object" || Array.isArray(tools)) {
    return { pins: null, problems: [`${PIN_FILE} must hold a "tools" object`] };
  }
  const problems = [];
  for (const [name, version] of Object.entries(tools)) {
    if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
      problems.push(`${PIN_FILE}: ${name} must be an exact X.Y.Z, got ${JSON.stringify(version)}`);
    }
  }
  return { pins: tools, problems };
}

/**
 * Find every taiki-e/install-action step in one YAML file.
 *
 * A step's `with:` block is the lines after `uses:` up to the next line indented
 * at or below the step's own `- ` marker (the next step, or the end of `steps:`).
 *
 * @param {string} text - workflow or composite action YAML.
 * @returns {{ line: number, ref: string, tool: string | null }[]} 1-based line of
 *   the `uses:`, the action ref, and the raw `tool:` value (null when absent).
 */
export function findInstallSteps(text) {
  const lines = text.split(/\r?\n/);
  const steps = [];
  lines.forEach((line, index) => {
    const match = line.match(USES_INSTALL_ACTION);
    if (!match) return;
    const [, indent, dash, ref] = match;
    // Indent of the step's "- " marker: on this line, or the nearest line above
    // that starts the list item (`- name: ...`).
    let stepIndent = indent.length;
    if (!dash) {
      for (let i = index - 1; i >= 0; i--) {
        const item = lines[i].match(/^(\s*)-\s/);
        if (item && item[1].length < indent.length) {
          stepIndent = item[1].length;
          break;
        }
      }
    }
    let tool = null;
    for (let i = index + 1; i < lines.length; i++) {
      const next = lines[i];
      if (next.trim() === "" || next.trim().startsWith("#")) continue;
      if (next.match(/^\s*/)[0].length <= stepIndent) break;
      const toolMatch = next.match(/^\s*tool:\s*(.*?)\s*(?:#.*)?$/);
      if (toolMatch) {
        tool = toolMatch[1].replace(/^['"]|['"]$/g, "");
        break;
      }
    }
    steps.push({ line: index + 1, ref, tool });
  });
  return steps;
}

/**
 * Run every rule against an in-memory view of the repo.
 *
 * @param {object} repo
 * @param {string | null} repo.pinFile - `.github/cargo-tools.json` contents.
 * @param {Record<string, string>} repo.files - workflows and composite actions.
 * @returns {string[]} human-readable problems; empty when consistent.
 */
export function findProblems(repo) {
  const { pins, problems } = parsePins(repo.pinFile);
  const used = new Set();
  for (const [name, text] of Object.entries(repo.files)) {
    for (const step of findInstallSteps(text)) {
      const where = `${name}:${step.line}`;
      if (!SHA_REF.test(step.ref)) {
        problems.push(
          `${where}: taiki-e/install-action@${step.ref} — pin the action to a commit SHA and ` +
            `name the tool in "tool: <name>@<version>"`
        );
        continue;
      }
      if (step.tool === null || step.tool === "" || step.tool.includes("${{")) {
        problems.push(`${where}: install-action step needs a literal "tool: <name>@<version>"`);
        continue;
      }
      for (const entry of step.tool
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)) {
        const at = entry.indexOf("@");
        const tool = at === -1 ? entry : entry.slice(0, at);
        const version = at === -1 ? null : entry.slice(at + 1);
        used.add(tool);
        if (version === null || !EXACT_VERSION.test(version)) {
          problems.push(`${where}: "${entry}" is unpinned — write ${tool}@X.Y.Z from ${PIN_FILE}`);
          continue;
        }
        if (pins === null) continue;
        if (!Object.hasOwn(pins, tool)) {
          problems.push(`${where}: ${tool} has no pin in ${PIN_FILE} — add it there`);
        } else if (pins[tool] !== version) {
          problems.push(
            `${where}: ${tool}@${version} differs from ${tool}@${pins[tool]} in ${PIN_FILE}`
          );
        }
      }
    }
  }
  for (const tool of Object.keys(pins ?? {})) {
    if (!used.has(tool)) {
      problems.push(`${PIN_FILE}: ${tool} is installed by no workflow — remove the stale pin`);
    }
  }
  return problems;
}

/** @returns {string | null} file contents, or null if the file does not exist. */
function readOrNull(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * Load the repo view `findProblems` expects from disk.
 *
 * @param {string} root - repository root.
 */
export function loadRepo(root) {
  const files = {};
  const workflows = path.join(root, ".github", "workflows");
  for (const f of existsSync(workflows) ? readdirSync(workflows) : []) {
    if (/\.ya?ml$/.test(f))
      files[`.github/workflows/${f}`] = readFileSync(path.join(workflows, f), "utf8");
  }
  const actionsDir = path.join(root, ".github", "actions");
  for (const dir of existsSync(actionsDir) ? readdirSync(actionsDir) : []) {
    for (const name of ["action.yml", "action.yaml"]) {
      const text = readOrNull(path.join(actionsDir, dir, name));
      if (text !== null) files[`.github/actions/${dir}/${name}`] = text;
    }
  }
  return { pinFile: readOrNull(path.join(root, PIN_FILE)), files };
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const repo = loadRepo(root);
  const problems = findProblems(repo);
  if (problems.length > 0) {
    console.error("cargo tool pin drift (see docs/contributing.md -> Cargo tool versions):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const pins = parsePins(repo.pinFile).pins;
  console.log(
    `cargo tools pinned once in ${PIN_FILE}: ` +
      Object.entries(pins)
        .map(([tool, version]) => `${tool}@${version}`)
        .join(", ")
  );
}
