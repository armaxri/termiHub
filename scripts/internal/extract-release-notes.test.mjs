import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  GITHUB_RELEASE_BODY_LIMIT,
  RELEASE_BODY_BUDGET,
  extractChangelogSection,
  capReleaseBody,
  changelogUrl,
} from "./extract-release-notes.mjs";
import { SECURITY_MARKER, hasSecuritySection } from "./emit-release-notes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(HERE, "extract-release-notes.mjs");

const SAMPLE = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "<!-- fragments go to docs/changes -->",
  "",
  "## [0.2.0-beta.1] - 2026-11-01",
  "",
  "### Added",
  "",
  "- beta thing (#2)",
  "",
  "## [0.1.0] - 2026-07-20",
  "",
  "First public beta.",
  "",
  "### Added",
  "",
  "- thing one (#1)",
  "- thing two (#1)",
  "",
  "### Fixed",
  "",
  "- a bug (#3)",
  "",
  "## [0.0.9] - 2026-06-01",
  "",
  "- old",
  "",
].join("\n");

describe("extractChangelogSection", () => {
  it("extracts the body under a real '## [X.Y.Z] - date' heading", () => {
    const section = extractChangelogSection(SAMPLE, "0.1.0");
    expect(section).toBe(
      [
        "First public beta.",
        "",
        "### Added",
        "",
        "- thing one (#1)",
        "- thing two (#1)",
        "",
        "### Fixed",
        "",
        "- a bug (#3)",
      ].join("\n")
    );
  });

  it("does not include the heading itself or the next version's section", () => {
    const section = extractChangelogSection(SAMPLE, "0.1.0");
    expect(section).not.toContain("## [0.1.0]");
    expect(section).not.toContain("old");
  });

  it("extracts the last section in the file (no following heading)", () => {
    expect(extractChangelogSection(SAMPLE, "0.0.9")).toBe("- old");
  });

  it("returns an empty string for a missing section", () => {
    expect(extractChangelogSection(SAMPLE, "9.9.9")).toBe("");
  });

  it("returns an empty string for a heading with an empty body", () => {
    const md = "## [1.0.0] - 2026-01-01\n\n## [0.9.0] - 2025-01-01\n- x\n";
    expect(extractChangelogSection(md, "1.0.0")).toBe("");
  });

  it("maps a pre-release tag to its own exact section (release-check.sh convention)", () => {
    expect(extractChangelogSection(SAMPLE, "0.2.0-beta.1")).toBe("### Added\n\n- beta thing (#2)");
  });

  it("accepts the tag form with a leading v", () => {
    expect(extractChangelogSection(SAMPLE, "v0.2.0-beta.1")).toBe("### Added\n\n- beta thing (#2)");
  });

  it("does not let a release version match its pre-release section or vice versa", () => {
    const md = "## [0.2.0-beta.1] - 2026-11-01\n\n- beta\n";
    expect(extractChangelogSection(md, "0.2.0")).toBe("");
    expect(extractChangelogSection(SAMPLE, "0.2.0-beta.2")).toBe("");
  });

  it("treats the dots in the version literally", () => {
    const md = "## [0x1y0] - 2026-01-01\n\n- wrong\n";
    expect(extractChangelogSection(md, "0.1.0")).toBe("");
  });

  it("handles CRLF line endings", () => {
    const md = SAMPLE.replace(/\n/g, "\r\n");
    expect(extractChangelogSection(md, "0.0.9")).toBe("- old");
  });

  it("returns an empty string for non-string input", () => {
    expect(extractChangelogSection(undefined, "0.1.0")).toBe("");
  });
});

describe("capReleaseBody", () => {
  const URL = "https://github.com/armaxri/termiHub/blob/v0.1.0/CHANGELOG.md";

  it("keeps the GitHub limit headroom for later appended notes", () => {
    expect(RELEASE_BODY_BUDGET).toBeLessThan(GITHUB_RELEASE_BODY_LIMIT);
  });

  it("returns a body under the budget unchanged", () => {
    expect(capReleaseBody("- small\n", { url: URL })).toBe("- small\n");
  });

  it("truncates an oversized body at a line boundary and links the full CHANGELOG", () => {
    const line = "- an entry that is reasonably long for a changelog bullet (#1234)";
    const body = Array.from({ length: 20000 }, (_, i) => `${line} ${i}`).join("\n");
    expect(body.length).toBeGreaterThan(GITHUB_RELEASE_BODY_LIMIT);

    const capped = capReleaseBody(body, { url: URL });
    expect(capped.length).toBeLessThanOrEqual(RELEASE_BODY_BUDGET);
    expect(capped).toContain(URL);
    // Every kept bullet is complete: the truncated part is a prefix of whole lines.
    const kept = capped.split("\n").filter((l) => l.startsWith("- an entry"));
    expect(kept.length).toBeGreaterThan(0);
    for (const l of kept) expect(body.split("\n")).toContain(l);
  });

  it("hard-cuts a single line longer than the budget", () => {
    const capped = capReleaseBody("x".repeat(500), { url: URL, limit: 300 });
    expect(capped.length).toBeLessThanOrEqual(300);
    expect(capped).toContain(URL);
  });

  it("keeps the security marker when truncation drops the Security section", () => {
    const filler = Array.from({ length: 50 }, (_, i) => `- added ${i}`).join("\n");
    const body = `### Added\n\n${filler}\n\n### Security\n\n- patched CVE`;
    const capped = capReleaseBody(body, { url: URL, limit: 400 });
    expect(capped.length).toBeLessThanOrEqual(400);
    expect(capped.startsWith(SECURITY_MARKER)).toBe(true);
  });

  it("does not add the marker when the body has no Security section", () => {
    const body = Array.from({ length: 50 }, (_, i) => `- added ${i}`).join("\n");
    expect(capReleaseBody(body, { url: URL, limit: 400 })).not.toContain(SECURITY_MARKER);
  });

  it("caps a full-history commit-log fallback (first release) under GitHub's limit", () => {
    // The first tag's fallback is every non-merge commit (~640 KB on this tree).
    const log = Array.from(
      { length: 8000 },
      (_, i) => `- fix(x): a commit subject number ${i} (abc${i})`
    ).join("\n");
    const capped = capReleaseBody(log, { url: URL });
    expect(capped.length).toBeLessThan(GITHUB_RELEASE_BODY_LIMIT);
    expect(capped).toContain(URL);
  });
});

describe("changelogUrl", () => {
  it("points at the tagged CHANGELOG.md in the workflow's repository", () => {
    expect(
      changelogUrl("0.1.0", {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "armaxri/termiHub",
      })
    ).toBe("https://github.com/armaxri/termiHub/blob/v0.1.0/CHANGELOG.md");
  });

  it("defaults to the upstream repository outside Actions", () => {
    expect(changelogUrl("v0.1.0", {})).toBe(
      "https://github.com/armaxri/termiHub/blob/v0.1.0/CHANGELOG.md"
    );
  });
});

describe("real CHANGELOG.md", () => {
  it("yields a non-empty, capped release body for the current package.json version", () => {
    const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const { version } = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    const section = extractChangelogSection(changelog, version);
    expect(section.length).toBeGreaterThan(0);
    const capped = capReleaseBody(section, { url: changelogUrl(version, {}) });
    expect(capped.length).toBeLessThanOrEqual(RELEASE_BODY_BUDGET);
    if (hasSecuritySection(section)) {
      expect(hasSecuritySection(capped) || capped.startsWith(SECURITY_MARKER)).toBe(true);
    }
  });
});

describe("CLI", () => {
  const run = (args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "armaxri/termiHub" },
    });
  const tmp = () => mkdtempSync(path.join(tmpdir(), "extract-release-notes-"));

  it("prints the section for a version found in the changelog", () => {
    const dir = tmp();
    const file = path.join(dir, "CHANGELOG.md");
    writeFileSync(file, SAMPLE);
    const res = run(["--version", "0.1.0", "--changelog", file]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("- thing two (#1)");
  });

  it("exits 2 when the changelog has no section for the version", () => {
    const dir = tmp();
    const file = path.join(dir, "CHANGELOG.md");
    writeFileSync(file, SAMPLE);
    const res = run(["--version", "9.9.9", "--changelog", file]);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("9.9.9");
  });

  it("caps a fallback commit log and links the full CHANGELOG", () => {
    const dir = tmp();
    const file = path.join(dir, "commits.txt");
    writeFileSync(
      file,
      Array.from({ length: 8000 }, (_, i) => `- chore: commit ${i} (abc)`).join("\n")
    );
    const res = run(["--version", "0.1.0", "--fallback", file]);
    expect(res.status).toBe(0);
    expect(res.stdout.length).toBeLessThanOrEqual(RELEASE_BODY_BUDGET);
    expect(res.stdout).toContain("blob/v0.1.0/CHANGELOG.md");
  });

  it("exits 1 on missing arguments", () => {
    expect(run(["--changelog", "CHANGELOG.md"]).status).toBe(1);
  });
});
