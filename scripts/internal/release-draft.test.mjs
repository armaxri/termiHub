// Guards for the draft-then-publish tag release (PKG2-006, #4361).
//
// release.yml used to publish the release before anything was built, and the
// build legs uploaded without --clobber: a leg that uploaded and then failed
// could not be finished by "re-run failed jobs" (the upload now failed on
// "already exists"), and the half-populated release was public meanwhile.
// These tests pin the fix:
//   - create-release creates a DRAFT through release-draft.sh;
//   - every `gh release upload` in release.yml passes --clobber;
//   - publish-release publishes after verify-release and before the install
//     smokes and mark-latest, and only it (plus create-release, mark-latest
//     and the uploaders) mutates the release;
//   - release-draft.sh, executed against a stub `gh`, creates a draft that is
//     never latest, reuses a draft on a re-run, refuses an already published
//     tag, and publishes with make_latest=false (a no-op when published).

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseWorkflowJobs } from "./pr-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE = readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
const SCRIPT = path.join(ROOT, "scripts/internal/release-draft.sh");

/** The body of one top-level job in `text`, up to the next job. */
function jobBody(text, id) {
  const start = text.indexOf(`\n  ${id}:\n`);
  expect(start, `job ${id}`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** parseWorkflowJobs plus release.yml's multi-line flow `needs:` lists. */
function releaseJobs() {
  const jobs = parseWorkflowJobs(RELEASE);
  const flow =
    /^ {2}([A-Za-z0-9_-]+):\s*\n(?:(?! {2}\S)[^\n]*\n)*? {4}needs:\s*\n\s*\[([^\]]*)\]/gm;
  for (const [, id, list] of RELEASE.matchAll(flow)) {
    const job = jobs.get(id);
    if (job && job.needs.length === 0) {
      job.needs = list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return jobs;
}

describe("release.yml draft-then-publish wiring (#4361)", () => {
  const jobs = releaseJobs();

  it("create-release creates the release as a draft via release-draft.sh", () => {
    const body = jobBody(RELEASE, "create-release");
    expect(body).toContain("scripts/internal/release-draft.sh create --tag");
    expect(body).not.toMatch(/gh release create\b/);
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toMatch(/flags=\(--draft --latest=false\)/);
  });

  it("every gh release upload passes --clobber (re-runnable legs)", () => {
    const uploads = RELEASE.split("\n").filter((l) => /\bgh release upload\b/.test(l));
    expect(uploads.length).toBeGreaterThanOrEqual(9);
    for (const line of uploads) expect(line, line.trim()).toContain("--clobber");
  });

  it("publish-release runs after verify-release and only publishes the draft", () => {
    const job = jobs.get("publish-release");
    expect(job).toBeDefined();
    expect(job.needs).toEqual(expect.arrayContaining(["create-release", "verify-release"]));
    expect(job.if).toBeUndefined();
    expect(job.continueOnError).toBe(false);
    const body = jobBody(RELEASE, "publish-release");
    expect(body).toContain('scripts/internal/release-draft.sh publish --tag "v${VERSION}"');
  });

  it("every install smoke and mark-latest need publish-release", () => {
    const smokes = [...jobs.keys()].filter((id) => id.startsWith("smoke-"));
    expect(smokes.length).toBe(5);
    for (const id of [...smokes, "mark-latest"]) {
      expect(jobs.get(id).needs, id).toContain("publish-release");
    }
  });

  it("verify-release can see the draft but never mutates a release", () => {
    const body = jobBody(RELEASE, "verify-release");
    // Drafts are only listed to a token with push access.
    expect(body).toMatch(/^ {6}contents: write\s*$/m);
    expect(body).not.toMatch(/gh release (create|edit|upload|delete|delete-asset)\b/);
    expect(body).not.toMatch(/gh api\b[^\n]*-X\s*(POST|PATCH|PUT|DELETE)/);
    expect(body).not.toMatch(/release-draft\.sh (create|publish)/);
  });

  it("only create-release and publish-release create or publish the release", () => {
    for (const id of jobs.keys()) {
      const body = jobBody(RELEASE, id);
      if (id !== "create-release") expect(body, id).not.toMatch(/release-draft\.sh create/);
      if (id !== "publish-release") expect(body, id).not.toMatch(/release-draft\.sh publish/);
      expect(body, id).not.toMatch(/gh release (create|delete)\b/);
      expect(body, id).not.toMatch(/--draft=false/);
    }
  });
});

// The helper is bash run on ubuntu runners; skip spawning bash on Windows
// (Git-Bash-on-PATH flake), the Unix legs cover it fully.
const describeUnix = process.platform === "win32" ? describe.skip : describe;

/**
 * A fake `gh` that logs every call to $GH_LOG. $GH_RELEASES is the listing
 * the releases API returns ("<id> <draft>" lines, already filtered by tag as
 * the real --jq would). After a successful PATCH the release reads as
 * published. $GH_FAIL names an operation to fail: create | edit | patch | list.
 */
const STUB_GH = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "release create") [ "$GH_FAIL" = create ] && exit 1; exit 0 ;;
  "release edit") [ "$GH_FAIL" = edit ] && exit 1; exit 0 ;;
esac
if [ "$1" = api ]; then
  case "$*" in
    *"-X PATCH"*)
      [ "$GH_FAIL" = patch ] && exit 1
      echo published > "$GH_STATE/patched"; exit 0 ;;
    *"releases?per_page"*)
      [ "$GH_FAIL" = list ] && exit 1
      if [ -f "$GH_STATE/patched" ]; then
        printf '%s\\n' "$GH_RELEASES" | sed 's/ true$/ false/'
      elif [ -n "$GH_RELEASES" ]; then
        printf '%s\\n' "$GH_RELEASES"
      fi
      exit 0 ;;
  esac
fi
echo "stub gh: unhandled: $*" >&2
exit 3
`;

describeUnix("release-draft.sh (executed)", () => {
  let dir;
  let notes;
  let log;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "release-draft-"));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "gh"), STUB_GH);
    chmodSync(path.join(bin, "gh"), 0o755);
    mkdirSync(path.join(dir, "state"));
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
        GH_RELEASES: "",
        RELEASE_DRAFT_RETRIES: "2",
        RELEASE_DRAFT_BACKOFF: "0",
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

  const createArgs = (...extra) => [
    "create",
    "--tag",
    "v1.2.3",
    "--title",
    "termiHub v1.2.3",
    "--notes",
    notes,
    ...extra,
  ];

  it("--help exits 0", () => {
    expect(run(["--help"]).status).toBe(0);
  });

  it("create makes a new draft that is never latest and verifies the tag", () => {
    const r = run(createArgs("--prerelease"));
    expect(r.status, r.stderr).toBe(0);
    const create = r.calls.find((c) => c.startsWith("release create v1.2.3"));
    expect(create).toBeDefined();
    expect(create).toContain("--draft");
    expect(create).toContain("--latest=false");
    expect(create).toContain("--verify-tag");
    expect(create).toContain("--prerelease");
  });

  it("create without --prerelease makes a stable draft", () => {
    const r = run(createArgs());
    expect(r.status, r.stderr).toBe(0);
    const create = r.calls.find((c) => c.startsWith("release create"));
    expect(create).toContain("--draft");
    expect(create).not.toContain("--prerelease");
  });

  it("create on a re-run reuses the existing draft instead of failing", () => {
    const r = run(createArgs("--prerelease"), { GH_RELEASES: "42 true" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c.startsWith("release create"))).toBe(false);
    const edit = r.calls.find((c) => c.startsWith("release edit v1.2.3"));
    expect(edit).toContain("--draft=true");
    expect(edit).toContain("--prerelease=true");
  });

  it("create refuses a tag whose release is already published", () => {
    const r = run(createArgs(), { GH_RELEASES: "42 false" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("already has a published release");
    expect(r.calls.some((c) => /^release (create|edit)/.test(c))).toBe(false);
  });

  it("create refuses an ambiguous tag with two releases", () => {
    const r = run(createArgs(), { GH_RELEASES: "42 true\n43 true" });
    expect(r.status).toBe(1);
    expect(r.calls.some((c) => /^release (create|edit)/.test(c))).toBe(false);
  });

  it("create fails when the release listing fails (never guesses)", () => {
    const r = run(createArgs(), { GH_FAIL: "list" });
    expect(r.status).toBe(1);
    expect(r.calls.some((c) => c.startsWith("release create"))).toBe(false);
  });

  it("create fails when gh release create fails", () => {
    expect(run(createArgs(), { GH_FAIL: "create" }).status).not.toBe(0);
  });

  it("create needs a notes file", () => {
    const r = run(["create", "--tag", "v1.2.3", "--title", "t", "--notes", "/nonexistent"]);
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });

  it("publish publishes the draft by id, explicitly not as latest", () => {
    const r = run(["publish", "--tag", "v1.2.3"], { GH_RELEASES: "42 true" });
    expect(r.status, r.stderr).toBe(0);
    const patch = r.calls.find((c) => c.includes("-X PATCH"));
    expect(patch).toContain("releases/42");
    expect(patch).toContain("draft=false");
    expect(patch).toContain("make_latest=false");
    expect(patch).not.toContain("prerelease");
    expect(r.stdout).toContain("Published v1.2.3");
  });

  it("publish on an already published release is a no-op", () => {
    const r = run(["publish", "--tag", "v1.2.3"], { GH_RELEASES: "42 false" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c.includes("-X PATCH"))).toBe(false);
  });

  it("publish fails when no release exists for the tag", () => {
    const r = run(["publish", "--tag", "v1.2.3"]);
    expect(r.status).toBe(1);
    expect(r.calls.some((c) => c.includes("-X PATCH"))).toBe(false);
  });

  it("publish retries and then fails with a recovery hint", () => {
    const r = run(["publish", "--tag", "v1.2.3"], { GH_RELEASES: "42 true", GH_FAIL: "patch" });
    expect(r.status).toBe(1);
    expect(r.calls.filter((c) => c.includes("-X PATCH"))).toHaveLength(2);
    expect(r.stdout).toContain("Recover with");
  });

  it("state reports none, draft and published", () => {
    expect(run(["state", "--tag", "v1.2.3"]).stdout.trim()).toBe("none");
    expect(run(["state", "--tag", "v1.2.3"], { GH_RELEASES: "42 true" }).stdout.trim()).toBe(
      "draft"
    );
    expect(run(["state", "--tag", "v1.2.3"], { GH_RELEASES: "42 false" }).stdout.trim()).toBe(
      "published"
    );
  });

  it("an unknown subcommand exits 2", () => {
    expect(run(["frobnicate"]).status).toBe(2);
  });
});
