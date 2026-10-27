#!/usr/bin/env node
// Keep third-party GitHub Actions pinned to ONE full commit SHA each (#4360).
//
// Every `uses: owner/repo[/path]@ref` in a workflow or composite action must
// pin a full 40-hex commit SHA (CI-004 / WA-CI-034: a tag or branch can be
// moved under us), carry a `# <version>` comment saying what that SHA is, and
// use the same SHA as every other use of that action. Pins are bumped by hand
// (no update bot: maintainer decision, #5011), SHA and comment together; this
// check catches the drift that leaves behind — a hand-edited or copy-pasted older pin,
// like the 7 upload-artifact v4.6.2 uses that sat next to 21 v7.0.1 uses
// before #4360. Local (`./…`) and `docker://` uses are not pins and are skipped.
//
// Usage: node scripts/internal/check-action-pins.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-action-pins.test.mjs).
// See docs/contributing.md -> "GitHub Actions pins".

import { existsSync, readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `uses: <action>@<ref>  # <comment>`, quoted or not, list or mapping form. */
const USES_LINE = /^\s*-?\s*uses:\s*['"]?([^\s'"@]+)@([^\s'"#]+)['"]?\s*(?:#\s*(.*))?$/;

/**
 * Collect every third-party action pin.
 *
 * @param {Record<string, string>} files - path -> YAML text.
 * @returns {{ action: string, ref: string, comment: string, where: string }[]}
 */
export function collectPins(files) {
  const pins = [];
  for (const [name, text] of Object.entries(files)) {
    text.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(USES_LINE);
      if (!match) return;
      const [, action, ref, comment] = match;
      if (action.startsWith("./") || action.startsWith("docker://")) return;
      pins.push({ action, ref, comment: (comment ?? "").trim(), where: `${name}:${index + 1}` });
    });
  }
  return pins;
}

/**
 * Run every pin rule.
 *
 * @param {Record<string, string>} files - workflows + composite actions.
 * @returns {string[]} human-readable problems; empty when consistent.
 */
export function findProblems(files) {
  const problems = [];
  const shasByAction = new Map();
  for (const pin of collectPins(files)) {
    if (!/^[0-9a-f]{40}$/.test(pin.ref)) {
      problems.push(`${pin.where}: ${pin.action}@${pin.ref} is not pinned to a full commit SHA`);
      continue;
    }
    if (pin.comment === "") {
      problems.push(`${pin.where}: ${pin.action}@${pin.ref} needs a "# vX.Y.Z" version comment`);
    }
    const seen = shasByAction.get(pin.action) ?? new Map();
    const where = seen.get(pin.ref) ?? [];
    where.push(`${pin.where} (${pin.comment || "no comment"})`);
    seen.set(pin.ref, where);
    shasByAction.set(pin.action, seen);
  }
  for (const [action, seen] of shasByAction) {
    if (seen.size < 2) continue;
    const variants = [...seen.values()].map((where) => where[0]).join(", ");
    problems.push(`${action} is pinned to ${seen.size} different SHAs — align them: ${variants}`);
  }
  return problems;
}

/**
 * Load every workflow and composite action YAML from disk.
 *
 * @param {string} root - repository root.
 * @returns {Record<string, string>} path -> YAML text.
 */
export function loadFiles(root) {
  const files = {};
  const workflowDir = path.join(root, ".github", "workflows");
  for (const f of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
    files[`.github/workflows/${f}`] = readFileSync(path.join(workflowDir, f), "utf8");
  }
  const actionsDir = path.join(root, ".github", "actions");
  for (const dir of existsSync(actionsDir) ? readdirSync(actionsDir) : []) {
    for (const name of ["action.yml", "action.yaml"]) {
      const file = path.join(actionsDir, dir, name);
      if (existsSync(file)) files[`.github/actions/${dir}/${name}`] = readFileSync(file, "utf8");
    }
  }
  return files;
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const files = loadFiles(root);
  const problems = findProblems(files);
  if (problems.length > 0) {
    console.error("GitHub Actions pin drift (see docs/contributing.md -> GitHub Actions pins):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const actions = new Set(collectPins(files).map((pin) => pin.action));
  console.log(`${actions.size} third-party actions, each pinned to one commit SHA.`);
}
