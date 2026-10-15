// Behavioural guard for release-check.sh's version-consistency gate (DOC2-007,
// #4340).
//
// The gate must cover every crate that ships with a release: the five original
// sources plus plugin-runner and rdp-sidecar (both bundled as sidecars and
// reporting their own version at runtime). plugin-api is the native-plugin ABI
// crate and is versioned independently on purpose (#3367), so a different
// version there must NOT fail the gate. The documented bump procedure in
// docs/contributing.md must list the same files the script compares.
//
// Each case runs the real script against a throwaway git repo holding only the
// version sources, so it never touches this checkout's manifests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = readFileSync(path.join(ROOT, "scripts/release-check.sh"), "utf8");

/** Cargo manifests the gate requires to equal package.json's version. */
const LOCKSTEP_CRATES = ["src-tauri", "agent", "core", "plugin-runner", "rdp-sidecar"];

/** Write a minimal Cargo manifest whose [package] version is on line 3. */
function writeCrate(dir, crate, version) {
  mkdirSync(path.join(dir, crate), { recursive: true });
  writeFileSync(
    path.join(dir, crate, "Cargo.toml"),
    `[package]\nname = "${crate}"\nversion = "${version}"\nedition = "2021"\n`
  );
}

/** A throwaway repo with every version source at `version`. */
function makeRepo(version) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "release-check-versions-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }, null, 2));
  mkdirSync(path.join(dir, "src-tauri"), { recursive: true });
  writeFileSync(path.join(dir, "src-tauri/tauri.conf.json"), JSON.stringify({ version }, null, 2));
  for (const crate of LOCKSTEP_CRATES) writeCrate(dir, crate, version);
  // plugin-api keeps its comment block above the version, like the real one.
  mkdirSync(path.join(dir, "plugin-api"), { recursive: true });
  writeFileSync(
    path.join(dir, "plugin-api/Cargo.toml"),
    `[package]\nname = "plugin-api"\n# Independently versioned.\nversion = "${version}"\n`
  );
  writeFileSync(path.join(dir, "Cargo.lock"), "version = 4\n");
  mkdirSync(path.join(dir, "scripts/internal"), { recursive: true });
  copyFileSync(
    path.join(ROOT, "scripts/release-check.sh"),
    path.join(dir, "scripts/release-check.sh")
  );
  for (const f of ["check-tauri-version-drift.mjs", "is-main-module.mjs"]) {
    copyFileSync(path.join(ROOT, "scripts/internal", f), path.join(dir, "scripts/internal", f));
  }
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function runVersionsOnly(dir, ...extra) {
  const result = spawnSync("bash", ["scripts/release-check.sh", "--versions-only", ...extra], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// The script is bash; the Windows .cmd twin is covered by test-release-check-cmd.ps1.
const describeUnix = process.platform === "win32" ? describe.skip : describe;

describeUnix("release-check.sh --versions-only", () => {
  let dir;
  beforeEach(() => {
    dir = makeRepo("1.2.3");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when all seven lockstep sources agree", () => {
    const { code, out } = runVersionsOnly(dir, "--expect-version", "v1.2.3");
    expect(out).toContain("PASS: All 7 files agree on version 1.2.3");
    expect(out).toContain("INFO: plugin-api/Cargo.toml is at 1.2.3");
    expect(out).not.toContain("FAIL:");
    expect(code).toBe(0);
  });

  it.each(["plugin-runner", "rdp-sidecar", "core", "agent", "src-tauri"])(
    "fails when %s/Cargo.toml was left behind on a bump",
    (crate) => {
      writeCrate(dir, crate, "1.2.2");
      const { code, out } = runVersionsOnly(dir);
      expect(out).toContain(`FAIL: ${crate}/Cargo.toml has version '1.2.2', expected '1.2.3'`);
      expect(out).toContain("RESULT: version checks FAILED");
      expect(code).toBe(1);
    }
  );

  it("does not fail on a different plugin-api version (independently versioned)", () => {
    writeFileSync(
      path.join(dir, "plugin-api/Cargo.toml"),
      `[package]\nname = "plugin-api"\nversion = "0.1.0"\n`
    );
    const { code, out } = runVersionsOnly(dir);
    expect(out).toContain("INFO: plugin-api/Cargo.toml is at 0.1.0");
    expect(out).not.toContain("FAIL:");
    expect(code).toBe(0);
  });

  it("fails when plugin-api has no readable version", () => {
    writeFileSync(path.join(dir, "plugin-api/Cargo.toml"), `[package]\nname = "plugin-api"\n`);
    const { code, out } = runVersionsOnly(dir);
    expect(out).toContain("FAIL: Could not read a version from plugin-api/Cargo.toml");
    expect(code).toBe(1);
  });
});

describe("version-bump procedure (docs/contributing.md)", () => {
  const doc = readFileSync(path.join(ROOT, "docs/contributing.md"), "utf8");
  const section = doc.slice(doc.indexOf("### Version Bump"), doc.indexOf("### Finalize Changelog"));
  const commit = doc.slice(doc.indexOf("### Commit, Tag, and Push"));

  const checked = ["src-tauri/tauri.conf.json", ...LOCKSTEP_CRATES.map((c) => `${c}/Cargo.toml`)];

  it.each(["package.json", ...checked])("lists %s in the bump list and the commit", (file) => {
    expect(SCRIPT).toContain(file === "package.json" ? "package.json" : file);
    expect(section).toContain(`**\`${file}\`**`);
    expect(commit.slice(0, commit.indexOf("git commit"))).toContain(file);
  });

  it("explains that plugin-api is not bumped with the app", () => {
    expect(section).toContain("plugin-api/Cargo.toml");
    expect(section).toMatch(/independently versioned/i);
  });
});
