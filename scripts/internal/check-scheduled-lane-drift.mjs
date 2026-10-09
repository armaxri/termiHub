#!/usr/bin/env node
// Scheduled-lane drift guard (#4277, audit CI2-001 / WA-CI2-001).
//
// GitHub reads `schedule:` and `workflow_run:` only from the default branch
// (`main`). A workflow that has one of them but exists only on `develop` is
// dark: its cron never fires. This check has two parts:
//
//   1. Registry (always fails on a problem): every workflow with `schedule:` or
//      `workflow_run:` must be a lane in scripts/internal/scheduled-lanes.mjs
//      (or the dispatcher itself), every dispatched lane must accept
//      `workflow_dispatch` (and the inputs the dispatcher passes), and the
//      crons in scheduled-dispatch.yml must match the registry. The vitest
//      suite runs this part against the real tree, so a PR that adds a
//      scheduled lane without registering it fails per PR.
//   2. Drift against main (annotates; fails only with --strict): each such
//      workflow is compared with its copy on `main`. "missing" means its own
//      cron is dark; "on-differs" means main fires a stale trigger set. Whether
//      a dark lane is still covered depends on scheduled-dispatch.yml being on
//      main, which is reported first.
//
// Usage:
//   node scripts/internal/check-scheduled-lane-drift.mjs [--main-ref origin/main]
//        [--strict] [--summary <md-file>]
//
// Needs the main ref locally (`git fetch origin main`). Annotations
// (`::warning`/`::error`) are emitted when GITHUB_ACTIONS is set.
// Exit codes: 0 ok (drift only annotated), 1 registry problem (or drift with
// --strict), 2 usage error or main ref unreadable.

import { execFileSync } from "child_process";
import { appendFileSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isMainModule } from "./is-main-module.mjs";
import {
  DISPATCHER_FILE,
  LANES,
  cronsOf,
  extractOnBlock,
  hasDefaultBranchOnlyTrigger,
  normalizedOnBlock,
  triggersOf,
} from "./scheduled-lanes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

/**
 * Read every workflow under .github/workflows as { name: text }.
 *
 * @param {string} [dir]
 * @returns {Record<string, string>}
 */
export function loadWorkflows(dir = WORKFLOW_DIR) {
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    out[name] = readFileSync(path.join(dir, name), "utf8");
  }
  return out;
}

/** True when the `on:` block declares `<key>:` under workflow_dispatch.inputs. */
function declaresInput(text, key) {
  const block = extractOnBlock(text) ?? [];
  const at = block.findIndex((l) => /^\s+workflow_dispatch\s*:/.test(l));
  if (at === -1) return false;
  const indent = block[at].match(/^\s*/)[0].length;
  for (let i = at + 1; i < block.length; i++) {
    const line = block[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    if (new RegExp(`^\\s+${key}\\s*:`).test(line)) return true;
  }
  return false;
}

/**
 * Registry problems: things that are wrong on develop regardless of main.
 *
 * @param {Record<string, string>} workflows name -> YAML text
 * @param {typeof LANES} [lanes]
 * @returns {string[]} one message per problem
 */
export function registryProblems(workflows, lanes = LANES) {
  const problems = [];
  const laneFiles = new Set(lanes.map((l) => l.file));

  for (const [name, text] of Object.entries(workflows)) {
    if (name === DISPATCHER_FILE) continue;
    if (hasDefaultBranchOnlyTrigger(text) && !laneFiles.has(name)) {
      problems.push(
        `${name} has a schedule:/workflow_run: trigger but is not a lane in ` +
          "scripts/internal/scheduled-lanes.mjs. GitHub fires it only from main, so it " +
          "stays dark until main has it. Register it (the dispatcher then starts it on " +
          "develop and the heartbeat watches it)."
      );
    }
  }

  for (const lane of lanes) {
    const text = workflows[lane.file];
    if (text === undefined) {
      problems.push(`${lane.file} is a lane in scheduled-lanes.mjs but does not exist.`);
      continue;
    }
    if (lane.dispatch && lane.cron === null) {
      problems.push(`${lane.file} is dispatched but has no cron in scheduled-lanes.mjs.`);
    }
    if (!lane.dispatch && lane.cron !== null) {
      problems.push(`${lane.file} is not dispatched but has a cron in scheduled-lanes.mjs.`);
    }
    if (lane.dispatch && !triggersOf(text).includes("workflow_dispatch")) {
      problems.push(
        `${lane.file} is dispatched by ${DISPATCHER_FILE} but has no workflow_dispatch trigger.`
      );
    }
    for (const key of Object.keys(lane.inputs ?? {})) {
      if (!declaresInput(text, key)) {
        problems.push(`${lane.file} does not declare the workflow_dispatch input "${key}".`);
      }
    }
  }

  const dispatcher = workflows[DISPATCHER_FILE];
  if (dispatcher === undefined) {
    problems.push(`${DISPATCHER_FILE} is missing.`);
  } else {
    const have = new Set(cronsOf(dispatcher));
    const want = new Set(lanes.filter((l) => l.cron).map((l) => l.cron));
    for (const c of want) {
      if (!have.has(c)) problems.push(`${DISPATCHER_FILE} lacks the cron "${c}" a lane uses.`);
    }
    for (const c of have) {
      if (!want.has(c)) problems.push(`${DISPATCHER_FILE} has the cron "${c}" that no lane uses.`);
    }
  }
  return problems;
}

/**
 * Compare each workflow with a default-branch-only trigger against main.
 *
 * @param {Record<string, string>} workflows name -> develop YAML
 * @param {(name: string) => string | null} readMain main's copy, or null when absent
 * @returns {{ file: string, status: "ok" | "missing" | "on-differs" }[]}
 */
export function driftFindings(workflows, readMain) {
  const findings = [];
  for (const [name, text] of Object.entries(workflows)) {
    if (!hasDefaultBranchOnlyTrigger(text)) continue;
    const main = readMain(name);
    let status = "ok";
    if (main === null) status = "missing";
    else if (normalizedOnBlock(main) !== normalizedOnBlock(text)) status = "on-differs";
    findings.push({ file: name, status });
  }
  // The dispatcher first: every other line depends on it.
  return findings.sort(
    (a, b) =>
      (b.file === DISPATCHER_FILE) - (a.file === DISPATCHER_FILE) || a.file.localeCompare(b.file)
  );
}

/**
 * Human-readable lines for the drift findings.
 *
 * @param {ReturnType<typeof driftFindings>} findings
 * @param {typeof LANES} [lanes]
 * @returns {{ level: "notice" | "warning", file: string, message: string }[]}
 */
export function describeDrift(findings, lanes = LANES) {
  const dispatcherOnMain = findings.some(
    (f) => f.file === DISPATCHER_FILE && f.status !== "missing"
  );
  const dispatched = new Set(lanes.filter((l) => l.dispatch).map((l) => l.file));
  return findings.map(({ file, status }) => {
    if (status === "ok") {
      return { level: "notice", file, message: `${file}: on main with the same on: block.` };
    }
    if (file === DISPATCHER_FILE) {
      const why =
        status === "missing"
          ? "is not on main, so none of its crons fire"
          : "differs on main, so main fires a stale cron set";
      return {
        level: "warning",
        file,
        message:
          `${file} ${why}. Develop pushes still dispatch stale lanes (catch-up), but a ` +
          "quiet day dispatches nothing. Land it on main (see docs/contributing.md).",
      };
    }
    const cover =
      dispatched.has(file) && dispatcherOnMain
        ? ` ${DISPATCHER_FILE} on main dispatches it on develop meanwhile.`
        : dispatched.has(file)
          ? " Only develop-push catch-up dispatches it until the dispatcher reaches main."
          : "";
    const what =
      status === "missing"
        ? "is not on main: its own schedule:/workflow_run: never fires."
        : "differs on main: main fires the stale trigger set.";
    return { level: "warning", file, message: `${file} ${what}${cover}` };
  });
}

/** Read `<ref>:.github/workflows/<name>` with git, or null when absent. */
export function gitMainReader(ref) {
  return (name) => {
    try {
      return execFileSync("git", ["show", `${ref}:.github/workflows/${name}`], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };
}

function parseArgs(argv) {
  const args = { mainRef: "origin/main", strict: false, summary: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--main-ref") args.mainRef = argv[++i];
    else if (a === "--strict") args.strict = true;
    else if (a === "--summary") args.summary = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.mainRef) throw new Error("--main-ref needs a value");
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message));
    return 2;
  }
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${args.mainRef}^{commit}`], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    console.error(`${args.mainRef} is not available locally (git fetch origin main).`);
    return 2;
  }
  const gha = Boolean(process.env.GITHUB_ACTIONS);
  const workflows = loadWorkflows();

  const problems = registryProblems(workflows);
  const findings = driftFindings(workflows, gitMainReader(args.mainRef));
  const lines = describeDrift(findings);

  const out = ["## Scheduled-lane drift (develop vs " + args.mainRef + ")", ""];
  out.push("| Workflow | On main |", "| --- | --- |");
  for (const f of findings) out.push(`| \`${f.file}\` | ${f.status} |`);
  out.push("");
  for (const l of lines) {
    if (l.level === "warning") {
      out.push(`- ${l.message}`);
      if (gha) console.log(`::warning file=.github/workflows/${l.file}::${l.message}`);
    }
  }
  for (const p of problems) {
    out.push(`- REGISTRY: ${p}`);
    if (gha) console.log(`::error::${p}`);
  }
  console.log(out.join("\n"));
  if (args.summary) appendFileSync(args.summary, out.join("\n") + "\n");

  if (problems.length > 0) return 1;
  if (args.strict && findings.some((f) => f.status !== "ok")) return 1;
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
