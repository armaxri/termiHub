// Guards the macOS first-launch steps against drift between the release body,
// dev-build.yml's release body and README.md (#4279, PKG2-005, #4472).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  FIRST_LAUNCH_STEPS,
  README_BEGIN,
  README_END,
  renderDevBuildNote,
  renderForArgs,
  renderReleaseBody,
} from "./macos-first-launch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoFile = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const readme = repoFile("README.md");
const releaseYml = repoFile(".github/workflows/release.yml");
const devBuildYml = repoFile(".github/workflows/dev-build.yml");
const quickstart = repoFile("docs/marketing/quickstart.md");

/** Strip per-line indentation so a block nested in a Markdown list compares equal. */
const dedent = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();

/** The steps README.md embeds between the markers. */
function readmeSteps() {
  const begin = readme.indexOf(README_BEGIN);
  const end = readme.indexOf(README_END);
  expect(begin, "README.md is missing the macos-first-launch:begin marker").toBeGreaterThan(-1);
  expect(end, "README.md is missing the macos-first-launch:end marker").toBeGreaterThan(begin);
  return readme.slice(begin + README_BEGIN.length, end);
}

/**
 * A right-click/Control-click → Open instruction that is NOT scoped to macOS 14
 * and earlier. That route no longer works for unnotarized apps on macOS 15+.
 */
function unscopedRightClickOpen(text) {
  return text
    .split("\n")
    .filter((line) => /(right|control)-click[^\n]*→\s*\**Open/i.test(line))
    .filter((line) => !/macOS 14[^\n]*earlier/i.test(line));
}

describe("macOS first-launch steps (single source)", () => {
  it("lead with the macOS 15+ System Settings → Open Anyway flow", () => {
    const first = FIRST_LAUNCH_STEPS.split("\n")[0];
    expect(first).toMatch(/macOS 15/);
    expect(first).toContain("System Settings → Privacy & Security");
    expect(first).toContain("Open Anyway");
  });

  it("keep the xattr one-liner", () => {
    expect(FIRST_LAUNCH_STEPS).toContain(
      "`xattr -dr com.apple.quarantine /Applications/termiHub.app`"
    );
  });

  it("offer right-click → Open only for macOS 14 and earlier", () => {
    expect(FIRST_LAUNCH_STEPS).toMatch(/right-click/i);
    expect(unscopedRightClickOpen(FIRST_LAUNCH_STEPS)).toEqual([]);
  });
});

describe("release body (release.yml)", () => {
  it("is appended from the single-source script", () => {
    expect(releaseYml).toContain(
      "node scripts/internal/macos-first-launch.mjs >> release_notes.md"
    );
  });

  it("carries the canonical steps after a separator", () => {
    const body = renderReleaseBody();
    expect(body.startsWith("\n---\n")).toBe(true);
    expect(body).toContain(FIRST_LAUNCH_STEPS);
  });

  it("no longer hard-codes a right-click → Open instruction", () => {
    expect(unscopedRightClickOpen(releaseYml)).toEqual([]);
  });
});

describe("README.md", () => {
  it("embeds exactly the canonical steps", () => {
    expect(dedent(readmeSteps())).toBe(dedent(FIRST_LAUNCH_STEPS));
  });

  it("does not tell macOS 15+ users to right-click → Open anywhere", () => {
    expect(unscopedRightClickOpen(readme)).toEqual([]);
  });
});

/**
 * The `run: |` script of a workflow step, found by its `- name:` line and
 * dedented. A small text scan (no YAML dependency): the script is every line
 * after `run: |` that is blank or indented deeper than the `run:` key.
 */
function stepRunScript(workflow, stepName) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  expect(start, `step "${stepName}" not found`).toBeGreaterThan(-1);
  const runAt = lines.findIndex((line, i) => i > start && /^\s+run: \|\s*$/.test(line));
  expect(runAt, `step "${stepName}" has no run: | block`).toBeGreaterThan(start);
  const keyIndent = lines[runAt].search(/\S/);
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const indent = Math.min(
    ...body.filter((line) => line.trim() !== "").map((line) => line.search(/\S/))
  );
  return body.map((line) => line.slice(indent)).join("\n");
}

describe("dev-build.yml release body", () => {
  const script = stepRunScript(devBuildYml, "Write release notes");

  it("takes the macOS note from the single-source script", () => {
    expect(script).toContain("node scripts/internal/macos-first-launch.mjs --dev-build");
  });

  it("no longer hard-codes the first-launch steps", () => {
    expect(script).not.toContain("Open Anyway");
    expect(unscopedRightClickOpen(devBuildYml)).toEqual([]);
  });

  it("keeps the Dev Build framing around the canonical steps", () => {
    const note = renderDevBuildNote();
    expect(note).toMatch(/^> \*\*macOS — one-time security confirmation required\.\*\*/);
    expect(note).toContain("dev builds are not notarized");
    // Every line stays inside the blockquote, and the steps are verbatim.
    expect(
      note
        .trimEnd()
        .split("\n")
        .every((line) => line.startsWith(">"))
    ).toBe(true);
    const unquoted = note.replace(/^> ?/gm, "");
    expect(unquoted).toContain(FIRST_LAUNCH_STEPS);
    expect(note.endsWith("\n")).toBe(true);
  });

  it("selects the variant from the CLI arguments", () => {
    expect(renderForArgs([])).toBe(renderReleaseBody());
    expect(renderForArgs(["--dev-build"])).toBe(renderDevBuildNote());
    expect(() => renderForArgs(["--dev"])).toThrow(/unknown argument/);
  });

  // Runs the step's real shell against the script, with the workflow
  // expressions filled in, as the publish-release job would (ubuntu, bash).
  it.skipIf(process.platform === "win32")("renders the note when the step runs", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const filled = script
      .replaceAll("${{ needs.prepare-release.outputs.branch }}", "develop")
      .replaceAll("${{ github.repository }}", "armaxri/termiHub")
      .replaceAll("${{ github.sha }}", sha);
    expect(filled).not.toContain("${{");
    const dir = mkdtempSync(path.join(os.tmpdir(), "dev-build-notes-"));
    try {
      symlinkSync(path.join(ROOT, "scripts"), path.join(dir, "scripts"));
      execFileSync("bash", ["-e", "-c", filled], {
        cwd: dir,
        env: { ...process.env, GITHUB_SHA: sha },
        stdio: ["ignore", "inherit", "inherit"],
      });
      const notes = readFileSync(path.join(dir, "release_notes.md"), "utf8");
      expect(notes).toContain(renderDevBuildNote());
      expect(notes).toContain(
        "[`0123456`](https://github.com/armaxri/termiHub/commit/" + sha + ")"
      );
      // The note sits between the installer table and the agent table.
      const noteAt = notes.indexOf(renderDevBuildNote());
      expect(notes.indexOf("### Desktop Installers")).toBeLessThan(noteAt);
      expect(notes.indexOf("### Agent Binaries")).toBeGreaterThan(noteAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("docs/marketing/quickstart.md", () => {
  it("points macOS 15+ users at Open Anyway, not right-click → Open", () => {
    expect(quickstart).toContain("Open Anyway");
    // The beta note wraps across lines; join them before the scoping check.
    expect(unscopedRightClickOpen(quickstart.replace(/\n>\s*/g, " "))).toEqual([]);
  });
});
