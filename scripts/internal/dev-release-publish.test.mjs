// Guards for the failure-safe dev release publish (#4471).
//
// Dev Build run 37898730852 deleted `dev-develop-latest`, then every build job
// failed and the publish job still "succeeded" with nothing to upload: the dev
// download page was empty. These tests pin the fix:
//   - no job other than publish-release mutates a GitHub release;
//   - publish-release needs every build job and runs only on success();
//   - publish fails when a required artifact is missing;
//   - dev-release-publish.sh stages assets in a draft and only deletes the old
//     release after the draft verified complete (executed against a stub `gh`).

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = readFileSync(path.join(ROOT, ".github/workflows/dev-build.yml"), "utf8");
const SCRIPT = path.join(ROOT, "scripts/internal/dev-release-publish.sh");
const PUBLISH_JOB = "publish-release";

/** Top-level job ids → their raw body text, in file order. */
function jobBodies(text) {
  const jobsStart = text.indexOf("\njobs:\n");
  expect(jobsStart).toBeGreaterThan(-1);
  const body = text.slice(jobsStart + "\njobs:\n".length);
  const bodies = new Map();
  const re = /^ {2}([A-Za-z0-9_-]+):\s*$/gm;
  const starts = [...body.matchAll(re)];
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : body.length;
    bodies.set(m[1], body.slice(m.index, end));
  });
  return bodies;
}

/** The job's `needs:` ids (inline, flow-list or block-list form). */
function needsOf(body) {
  const flow =
    body.match(/^ {4}needs:\s*\[([^\]]*)\]/m) ?? body.match(/^ {4}needs:\s*\n\s*\[([^\]]*)\]/m);
  if (flow) {
    return flow[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const scalar = body.match(/^ {4}needs:\s*([A-Za-z0-9_-]+)\s*$/m);
  if (scalar) return [scalar[1]];
  const block = body.match(/^ {4}needs:\s*\n((?: {6}- .+\n)+)/m);
  return block
    ? block[1]
        .split("\n")
        .filter(Boolean)
        .map((l) => l.replace(/^ {6}- /, "").trim())
    : [];
}

/** Commands and actions that create, edit, upload to or delete a GitHub release. */
const RELEASE_MUTATIONS = [
  /\bgh\s+release\s+(create|delete|edit|upload|delete-asset)\b/,
  /\bgh\s+api\b[^\n]*-X\s*(POST|PATCH|PUT|DELETE)\b[^\n]*releases/,
  /\bdev-release-publish\.sh\s+publish\b/,
  /softprops\/action-gh-release/,
  /ncipollo\/release-action/,
  /actions\/(create-release|upload-release-asset)/,
];

describe("dev-build.yml release mutation boundary (#4471)", () => {
  const jobs = jobBodies(WORKFLOW);
  const buildJobs = [...jobs.keys()].filter((id) => id.startsWith("build-"));

  it("finds the publish job and the build jobs", () => {
    expect(jobs.has(PUBLISH_JOB)).toBe(true);
    expect(buildJobs).toEqual(
      expect.arrayContaining([
        "build-app",
        "build-agents-linux",
        "build-agents-macos",
        "build-agents-windows",
      ])
    );
  });

  it("mutates no release in any job except publish-release", () => {
    for (const [id, body] of jobs) {
      if (id === PUBLISH_JOB) continue;
      for (const pattern of RELEASE_MUTATIONS) {
        expect(body, `${id} must not mutate a release (${pattern})`).not.toMatch(pattern);
      }
    }
  });

  it("keeps tauri-action from creating or uploading to a release", () => {
    for (const [id, body] of jobs) {
      if (!body.includes("tauri-apps/tauri-action")) continue;
      expect(body, id).toMatch(/^ {10}tagName: ''\s*$/m);
      expect(body, id).not.toMatch(/releaseId:/);
    }
  });

  it("publish-release needs every other job", () => {
    const needs = needsOf(jobs.get(PUBLISH_JOB));
    const others = [...jobs.keys()].filter((id) => id !== PUBLISH_JOB);
    expect(needs.sort()).toEqual(others.sort());
  });

  it("publish-release runs only when every needed job succeeded", () => {
    const body = jobs.get(PUBLISH_JOB);
    const cond = body.match(/^ {4}if:\s*(.+)$/m);
    // Absent `if:` is the implicit success(); an explicit one must be exactly it.
    if (cond) expect(cond[1].trim()).toBe("${{ success() }}");
    expect(body).not.toMatch(/always\(\)|!cancelled\(\)|failure\(\)|continue-on-error/);
  });

  it("publish-release checks required artifacts before publishing", () => {
    const body = jobs.get(PUBLISH_JOB);
    const check = body.indexOf("dev-release-publish.sh check-artifacts artifacts/");
    const publish = body.indexOf("dev-release-publish.sh publish");
    expect(check).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(check);
    // The check step must not be softened.
    const step = body.slice(body.lastIndexOf("- name:", check), publish);
    expect(step.split("- name:")[1]).not.toMatch(/continue-on-error|\|\| true/);
  });

  it("every agent build artifact is required by check-artifacts", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const names = [...WORKFLOW.matchAll(/artifact_name: (termihub-agent-[\w.-]+)/g)].map(
      (m) => m[1]
    );
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) expect(script).toContain(`"${name}|`);
  });
});

// The helper is bash run on the ubuntu publish runner; skip spawning bash on
// Windows (Git-Bash-on-PATH flake), the Unix legs cover it fully.
const describeUnix = process.platform === "win32" ? describe.skip : describe;

const REQUIRED = [
  "termiHub-dev-macos-x64.dmg",
  "termiHub-dev-macos-arm64.dmg",
  "termiHub-dev-windows-x64.msi",
  "termiHub-dev-linux-x64.AppImage",
  "termiHub-dev-linux-arm64.deb",
  "termihub-agent-linux-x64",
  "termihub-agent-linux-arm64",
  "termihub-agent-linux-armv7",
  "termihub-agent-macos-arm64",
  "termihub-agent-macos-x64",
  "termihub-agent-windows-x64.exe",
  "termihub-agent-windows-arm64.exe",
];

/**
 * A fake `gh` that logs every call to $GH_LOG and fails the operation named in
 * $GH_FAIL (create | delete | publish). The draft lists the files it was given
 * as uploaded assets unless $GH_DROP_ASSET names one to leave out.
 */
const STUB_GH = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "release create")
    [ "$GH_FAIL" = create ] && exit 1
    shift 3
    for a in "$@"; do
      case "$a" in --*) break ;; esac
      b="$(basename "$a")"
      [ "$b" = "$GH_DROP_ASSET" ] || echo "$b" >> "$GH_STATE/assets"
    done
    exit 0 ;;
  "release view") [ -n "$GH_HAS_OLD" ] && exit 0; exit 1 ;;
  "release delete") [ "$GH_FAIL" = delete ] && exit 1; exit 0 ;;
esac
if [ "$1" = api ]; then
  case "$*" in
    *"-X PATCH"*) [ "$GH_FAIL" = publish ] && exit 1; exit 0 ;;
    *"-X DELETE"*) exit 0 ;;
    *"startswith"*) echo 7; echo 42; exit 0 ;;
    *"releases?per_page"*) echo 42; exit 0 ;;
    *"releases/42"*) cat "$GH_STATE/assets" 2>/dev/null; exit 0 ;;
  esac
fi
echo "stub gh: unhandled: $*" >&2
exit 3
`;

describeUnix("dev-release-publish.sh (executed)", () => {
  let dir;
  let artifacts;
  let notes;
  let log;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dev-release-publish-"));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "gh"), STUB_GH);
    chmodSync(path.join(bin, "gh"), 0o755);
    mkdirSync(path.join(dir, "state"));
    artifacts = path.join(dir, "artifacts");
    mkdirSync(artifacts);
    for (const f of REQUIRED) writeFileSync(path.join(artifacts, f), f);
    notes = path.join(dir, "notes.md");
    writeFileSync(notes, "notes");
    log = path.join(dir, "gh.log");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(args, env = {}) {
    const result = spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
        GH_LOG: log,
        GH_STATE: path.join(dir, "state"),
        GH_FAIL: "",
        GH_DROP_ASSET: "",
        GH_HAS_OLD: "1",
        GITHUB_RUN_ID: "99",
        DEV_RELEASE_PUBLISH_RETRIES: "2",
        DEV_RELEASE_PUBLISH_BACKOFF: "0",
        ...env,
      },
    });
    let calls = [];
    try {
      calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      // No gh call was made.
    }
    return { ...result, calls };
  }

  const publishArgs = () => [
    "publish",
    "--tag",
    "dev-develop-latest",
    "--sha",
    "abc123",
    "--dir",
    artifacts,
    "--title",
    "Dev Build",
    "--notes",
    notes,
  ];

  const index = (calls, re) => calls.findIndex((c) => re.test(c));

  it("--help exits 0", () => {
    expect(run(["--help"]).status).toBe(0);
  });

  it("check-artifacts passes when every required artifact is present", () => {
    const r = run(["check-artifacts", artifacts]);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it("check-artifacts fails and names each missing artifact", () => {
    rmSync(path.join(artifacts, "termihub-agent-windows-arm64.exe"));
    rmSync(path.join(artifacts, "termiHub-dev-macos-x64.dmg"));
    const r = run(["check-artifacts", artifacts]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("termihub-agent-windows-arm64.exe");
    expect(r.stdout).toContain("termiHub-dev-macos-x64.dmg");
  });

  it("check-artifacts fails on an empty artifact directory (all builds failed)", () => {
    for (const f of REQUIRED) rmSync(path.join(artifacts, f));
    expect(run(["check-artifacts", artifacts]).status).toBe(1);
  });

  it("publish stages a draft, verifies it, then swaps it in", () => {
    const r = run(publishArgs());
    expect(r.status, r.stderr).toBe(0);
    const create = index(r.calls, /^release create dev-develop-latest-staging-99 .*--draft/);
    const del = index(r.calls, /^release delete dev-develop-latest --yes --cleanup-tag/);
    const patch = index(r.calls, /-X PATCH .*releases\/42 .*tag_name=dev-develop-latest/);
    expect(create).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(create);
    expect(patch).toBeGreaterThan(del);
    expect(r.calls[patch]).toContain("target_commitish=abc123");
    expect(r.calls[patch]).toContain("draft=false");
    expect(r.calls[patch]).toContain("make_latest=false");
    // The stale draft 7 is tidied; our just-published release 42 is not.
    expect(index(r.calls, /-X DELETE .*releases\/7$/)).toBeGreaterThan(patch);
    expect(r.calls.some((c) => /-X DELETE .*releases\/42$/.test(c))).toBe(false);
  });

  it("a failed upload leaves the old release untouched", () => {
    const r = run(publishArgs(), { GH_FAIL: "create" });
    expect(r.status).toBe(1);
    expect(r.calls.some((c) => c.startsWith("release delete"))).toBe(false);
    expect(r.calls.some((c) => c.includes("-X PATCH"))).toBe(false);
  });

  it("an incomplete draft is discarded and the old release kept", () => {
    const r = run(publishArgs(), { GH_DROP_ASSET: "termihub-agent-linux-x64" });
    expect(r.status).toBe(1);
    expect(r.calls.some((c) => c.startsWith("release delete"))).toBe(false);
    expect(index(r.calls, /-X DELETE .*releases\/42$/)).toBeGreaterThan(-1);
  });

  it("a failed delete of the old release discards the draft and fails", () => {
    const r = run(publishArgs(), { GH_FAIL: "delete" });
    expect(r.status).toBe(1);
    expect(r.calls.some((c) => c.includes("-X PATCH"))).toBe(false);
    expect(index(r.calls, /-X DELETE .*releases\/42$/)).toBeGreaterThan(-1);
  });

  it("a failed publish keeps the complete draft and fails with a recovery hint", () => {
    const r = run(publishArgs(), { GH_FAIL: "publish" });
    expect(r.status).toBe(1);
    expect(r.calls.filter((c) => c.includes("-X PATCH"))).toHaveLength(2);
    expect(r.calls.some((c) => /-X DELETE .*releases\/42$/.test(c))).toBe(false);
    expect(r.stdout).toContain("Recover with");
  });

  it("publishes without a delete when no old release exists, still clearing a stale tag", () => {
    const r = run(publishArgs(), { GH_HAS_OLD: "" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c.startsWith("release delete"))).toBe(false);
    expect(index(r.calls, /-X DELETE .*git\/refs\/tags\/dev-develop-latest/)).toBeGreaterThan(-1);
  });
});
