// Guards the macOS first-launch steps against drift between the release body,
// dev-build.yml's release body and README.md (#4279, PKG2-005).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  FIRST_LAUNCH_STEPS,
  README_BEGIN,
  README_END,
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

describe("dev-build.yml release body", () => {
  it("documents the same System Settings → Open Anyway flow", () => {
    // dev-build.yml echoes Markdown inside double quotes, where `\&` stays a
    // Markdown-escaped ampersand; unescape before comparing.
    const text = devBuildYml.replace(/\\&/g, "&");
    expect(text).toContain("System Settings → Privacy & Security");
    expect(text).toContain("Open Anyway");
    expect(unscopedRightClickOpen(devBuildYml)).toEqual([]);
  });
});

describe("docs/marketing/quickstart.md", () => {
  it("points macOS 15+ users at Open Anyway, not right-click → Open", () => {
    expect(quickstart).toContain("Open Anyway");
    // The beta note wraps across lines; join them before the scoping check.
    expect(unscopedRightClickOpen(quickstart.replace(/\n>\s*/g, " "))).toEqual([]);
  });
});
