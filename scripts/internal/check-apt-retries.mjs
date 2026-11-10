#!/usr/bin/env node
// Keep every apt download in CI retrying (#5152).
//
// apt does not retry a failed download by default, so a transient
// archive.ubuntu.com outage reds an otherwise-green job on its first attempt
// (nightly 42550867340 and PR #5150 both died that way). Containers do not
// inherit the runner's apt config, so each context carries its own setting:
//
//   - runner jobs (workflows, composite actions): a host `sudo apt-get ...`
//     needs a `uses: ./.github/actions/apt-retries` step earlier in the same job
//     (it writes /etc/apt/apt.conf.d/80-ci-retries);
//   - in-container calls in workflows (`docker run ... apt-get ...`, i.e. an
//     apt call without `sudo`): `-o Acquire::Retries=N` on the call itself;
//   - Dockerfiles: a RUN that writes `Acquire::Retries` into /etc/apt/apt.conf.d/
//     earlier in the same stage (or in the stage it is built `FROM`), or the
//     inline `-o` flag;
//   - shell scripts: the inline `-o` flag, or a write of the conf file earlier
//     in the script.
//
// An "apt call" is `apt-get` or `apt` whose sub-command downloads (update,
// install, upgrade, ...). Comment lines and echo/printf hint lines are skipped;
// a line that only mentions an apt command in prose (an error hint) can opt out
// with an `apt-retries: ignore` comment.
//
// Usage: node scripts/internal/check-apt-retries.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-apt-retries.test.mjs).

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The composite action that writes the runner's apt retry config. */
export const RETRY_ACTION = "./.github/actions/apt-retries";

/** apt sub-commands that download from a mirror. */
const DOWNLOAD_VERBS = new Set([
  "update",
  "install",
  "reinstall",
  "upgrade",
  "dist-upgrade",
  "full-upgrade",
  "build-dep",
  "source",
  "download",
]);

/** apt options that take a separate value argument (`-o X=Y`, `-c file`, `-t rel`). */
const OPTIONS_WITH_VALUE = new Set(["-o", "-c", "-t", "--option", "--config-file"]);

const RETRY_FLAG = /Acquire::Retries/;
const IGNORE_MARKER = /#\s*apt-retries:\s*ignore\b/;
const RETRY_ACTION_USE = /^\s*-?\s*uses:\s*['"]?\.\/\.github\/actions\/apt-retries['"]?\s*(#.*)?$/;

/**
 * Join backslash-continued lines into logical lines.
 *
 * @param {string} text
 * @returns {{ line: number, text: string }[]} 1-based start line + joined text.
 */
export function logicalLines(text) {
  const out = [];
  let current = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    if (current === null) current = { line: index + 1, text: "" };
    const continued = /\\\s*$/.test(raw);
    current.text += (current.text ? " " : "") + (continued ? raw.replace(/\\\s*$/, "") : raw);
    if (!continued) {
      out.push(current);
      current = null;
    }
  });
  if (current !== null) out.push(current);
  return out;
}

/**
 * Find the downloading apt calls in one logical line.
 *
 * @param {string} text - one logical (continuation-joined) line.
 * @returns {{ verb: string, sudo: boolean, retries: boolean }[]}
 */
export function aptCalls(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("#") || /^(echo|printf)\b/.test(trimmed)) return [];
  if (IGNORE_MARKER.test(text)) return [];
  const calls = [];
  const re = /(^|[\s;&|('"`])(apt(?:-get)?)(?=\s)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const start = match.index + match[1].length;
    const after = text.slice(start + match[2].length);
    // The command's own arguments end at the next shell separator.
    const segment = after.split(/&&|\|\||[;|'"`)]/)[0];
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let verb = null;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (OPTIONS_WITH_VALUE.has(token)) {
        i += 1;
        continue;
      }
      if (token.startsWith("-")) continue;
      verb = token;
      break;
    }
    if (verb === null || !DOWNLOAD_VERBS.has(verb)) continue;
    const before = text.slice(0, start);
    calls.push({
      verb,
      sudo: /\bsudo(\s+-\S+)*\s+$/.test(before),
      retries: RETRY_FLAG.test(segment),
    });
  }
  return calls;
}

/** True when a logical line writes an apt retry config into apt.conf.d. */
function writesRetryConf(text) {
  return RETRY_FLAG.test(text) && /\/etc\/apt\/apt\.conf\.d\//.test(text);
}

/**
 * Check a Dockerfile: every apt call needs the conf file earlier in its stage
 * (inherited through `FROM <earlier-stage>`) or the inline flag.
 */
export function checkDockerfile(name, text) {
  const problems = [];
  const stages = new Map();
  let configured = false;
  let stageName = null;
  for (const { line, text: logical } of logicalLines(text)) {
    const from = logical.match(/^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      if (stageName !== null) stages.set(stageName, configured);
      configured = stages.get(from[1].toLowerCase()) ?? false;
      stageName = from[2] ? from[2].toLowerCase() : null;
      continue;
    }
    if (logical.trim().startsWith("#")) continue;
    for (const call of aptCalls(logical)) {
      if (!configured && !call.retries) {
        problems.push(
          `${name}:${line}: apt-get ${call.verb} without retries — write ` +
            `Acquire::Retries into /etc/apt/apt.conf.d/80-ci-retries earlier in this stage`
        );
      }
    }
    if (writesRetryConf(logical)) configured = true;
  }
  return problems;
}

/**
 * Check a workflow (per job) or composite action (whole file).
 *
 * @param {string} name
 * @param {string} text
 * @param {boolean} isWorkflow - split scopes at `jobs:` children when true.
 */
export function checkYaml(name, text, isWorkflow) {
  const problems = [];
  let configured = false;
  let inJobs = false;
  let jobIndent = null;
  for (const { line, text: logical } of logicalLines(text)) {
    if (isWorkflow) {
      if (/^jobs:\s*(#.*)?$/.test(logical)) {
        inJobs = true;
        configured = false;
        continue;
      }
      if (/^\S/.test(logical)) inJobs = false;
      const key = logical.match(/^(\s+)[A-Za-z0-9_-]+:\s*(#.*)?$/);
      if (inJobs && key && (jobIndent === null || key[1].length === jobIndent)) {
        jobIndent = key[1].length;
        configured = false;
        continue;
      }
    }
    if (RETRY_ACTION_USE.test(logical)) {
      configured = true;
      continue;
    }
    // A step or job `name:` / `description:` is prose, not a command.
    if (/^\s*-?\s*(name|description):/.test(logical)) continue;
    for (const call of aptCalls(logical)) {
      if (call.retries) continue;
      if (call.sudo && !configured) {
        problems.push(
          `${name}:${line}: sudo apt-get ${call.verb} without retries — add a ` +
            `\`uses: ${RETRY_ACTION}\` step before the job's first apt call`
        );
      } else if (!call.sudo) {
        problems.push(
          `${name}:${line}: apt-get ${call.verb} without retries — an apt call without sudo ` +
            `runs in a container, which does not inherit the runner config: pass ` +
            `-o Acquire::Retries=5`
        );
      }
    }
  }
  return problems;
}

/** Check a shell script: the inline flag, or a conf-file write earlier on. */
export function checkShell(name, text) {
  const problems = [];
  let configured = false;
  for (const { line, text: logical } of logicalLines(text)) {
    for (const call of aptCalls(logical)) {
      if (!configured && !call.retries) {
        problems.push(
          `${name}:${line}: apt-get ${call.verb} without retries — pass -o Acquire::Retries=5`
        );
      }
    }
    if (!logical.trim().startsWith("#") && writesRetryConf(logical)) configured = true;
  }
  return problems;
}

/** Classify a repo-relative path, or null when it is not checked. */
export function kindOf(file) {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) return "workflow";
  if (/^\.github\/actions\/[^/]+\/action\.ya?ml$/.test(file)) return "action";
  const base = path.posix.basename(file);
  if (/^(Dockerfile|Containerfile)(\..+)?$/.test(base) || /\.[Dd]ockerfile$/.test(base)) {
    return "dockerfile";
  }
  if (/\.(sh|bash)$/.test(base)) return "shell";
  return null;
}

/**
 * Run every rule against an in-memory view of the repo.
 *
 * @param {Record<string, string>} files - repo-relative path -> contents.
 * @returns {string[]} human-readable problems; empty when every call retries.
 */
export function findProblems(files) {
  const problems = [];
  for (const [name, text] of Object.entries(files)) {
    const kind = kindOf(name);
    if (kind === "workflow") problems.push(...checkYaml(name, text, true));
    else if (kind === "action") problems.push(...checkYaml(name, text, false));
    else if (kind === "dockerfile") problems.push(...checkDockerfile(name, text));
    else if (kind === "shell") problems.push(...checkShell(name, text));
  }
  return problems;
}

/**
 * Load every tracked file this check covers.
 *
 * @param {string} root - repository root.
 * @returns {Record<string, string>}
 */
export function loadFiles(root) {
  const listing = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  const files = {};
  for (const file of listing.split("\0").filter(Boolean)) {
    if (kindOf(file) === null) continue;
    try {
      files[file] = readFileSync(path.join(root, file), "utf8");
    } catch {
      // Tracked but deleted in the working tree: nothing to check.
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
    console.error("apt calls without download retries (#5152):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `apt retries: every apt download in ${Object.keys(files).length} workflow, action, ` +
      `Dockerfile and shell files retries.`
  );
}
