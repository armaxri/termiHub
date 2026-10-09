// Tests for the Windows MSI version mapping (#4283, PKG2-003).
//
// Tauri's WiX bundler rejects an app version whose prerelease is not numeric
// (X.Y.Z-beta.1), so release.yml maps every release tag to a numeric
// major.minor.patch.revision and passes it as bundle.windows.wix.version
// through a generated --config fragment on the Windows leg. verify-version runs
// the same script with --check so a tag the mapping rejects fails before
// create-release.

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BETA_BASE,
  RC_BASE,
  FINAL_REVISION,
  PRERELEASE_MAX,
  msiVersion,
  wixConfigFragment,
} from "./msi-version.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(HERE, "msi-version.mjs");
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

/** Compare two dotted numeric versions field by field. */
function compareMsi(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

describe("msiVersion mapping", () => {
  it("maps beta.N into the beta range", () => {
    expect(msiVersion("0.2.0-beta.1")).toBe(`0.2.0.${BETA_BASE + 1}`);
    expect(msiVersion("0.2.0-beta.0")).toBe(`0.2.0.${BETA_BASE}`);
  });

  it("maps rc.N into the rc range", () => {
    expect(msiVersion("0.2.0-rc.1")).toBe(`0.2.0.${RC_BASE + 1}`);
  });

  it("maps a final release to the highest revision", () => {
    expect(msiVersion("0.2.0")).toBe(`0.2.0.${FINAL_REVISION}`);
  });

  it("accepts a leading v (the raw tag name)", () => {
    expect(msiVersion("v1.4.2-rc.3")).toBe(`1.4.2.${RC_BASE + 3}`);
  });

  it("uses disjoint ranges: beta < rc < final, all within the WiX revision limit", () => {
    expect(BETA_BASE + PRERELEASE_MAX).toBeLessThan(RC_BASE);
    expect(RC_BASE + PRERELEASE_MAX).toBeLessThan(FINAL_REVISION);
    expect(FINAL_REVISION).toBeLessThanOrEqual(65535);
  });

  it("is strictly monotonic across beta.N -> rc.N -> final -> next patch", () => {
    const order = [
      "0.2.0-beta.0",
      "0.2.0-beta.1",
      "0.2.0-beta.2",
      "0.2.0-beta.10",
      `0.2.0-beta.${PRERELEASE_MAX}`,
      "0.2.0-rc.0",
      "0.2.0-rc.1",
      "0.2.0-rc.11",
      `0.2.0-rc.${PRERELEASE_MAX}`,
      "0.2.0",
      "0.2.1-beta.1",
      "0.2.1",
      "0.3.0-beta.1",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    const mapped = order.map(msiVersion);
    for (let i = 1; i < mapped.length; i += 1) {
      expect(compareMsi(mapped[i - 1], mapped[i]), `${order[i - 1]} < ${order[i]}`).toBeLessThan(0);
    }
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it("accepts the WiX field limits exactly", () => {
    expect(msiVersion("255.255.65535")).toBe(`255.255.65535.${FINAL_REVISION}`);
  });

  it.each([
    ["256.0.0", /major/],
    ["0.256.0", /minor/],
    ["0.0.65536", /patch/],
    [`0.2.0-beta.${PRERELEASE_MAX + 1}`, /beta/],
    [`0.2.0-rc.${PRERELEASE_MAX + 1}`, /rc/],
    ["0.2.0-alpha.1", /beta\.N or rc\.N/],
    ["0.2.0-1", /beta\.N or rc\.N/],
    ["0.2.0-beta", /beta\.N or rc\.N/],
    ["0.2.0-beta.1.2", /beta\.N or rc\.N/],
    ["0.2.0-BETA.1", /beta\.N or rc\.N/],
    ["0.2.0-beta.01", /beta\.N or rc\.N/],
    ["0.2.0+build.5", /beta\.N or rc\.N/],
    ["0.2", /not a release version/],
    ["01.2.0", /not a release version/],
    ["v0.2.0.1", /not a release version/],
    ["", /not a release version/],
  ])("rejects %s", (version, message) => {
    expect(() => msiVersion(version)).toThrow(message);
  });
});

describe("wixConfigFragment", () => {
  it("sets only bundle.windows.wix.version", () => {
    expect(wixConfigFragment("0.2.0-beta.1")).toEqual({
      bundle: { windows: { wix: { version: `0.2.0.${BETA_BASE + 1}` } } },
    });
  });

  it("throws for a rejected version", () => {
    expect(() => wixConfigFragment("0.2.0-alpha.1")).toThrow();
  });
});

describe("msi-version.mjs CLI", () => {
  it("prints the mapped version", () => {
    const r = run("0.2.0-rc.2");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`0.2.0.${RC_BASE + 2}`);
  });

  it("--check passes a supported tag and prints nothing to stderr", () => {
    const r = run("--check", "v0.2.0-beta.4");
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("--check fails a tag the MSI bundler would reject, with an annotation", () => {
    const r = run("--check", "v0.2.0-alpha.1");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::");
    expect(r.stdout).toContain("0.2.0-alpha.1");
  });

  it("--config-out writes a Tauri config fragment", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "msi-version-"));
    const out = path.join(dir, "wix.conf.json");
    const r = run("--config-out", out, "0.2.0-beta.3");
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      bundle: { windows: { wix: { version: `0.2.0.${BETA_BASE + 3}` } } },
    });
  });

  it("exits 2 on bad usage", () => {
    expect(run().status).toBe(2);
    expect(run("--config-out").status).toBe(2);
    expect(run("--bogus", "0.2.0").status).toBe(2);
  });
});

describe("release.yml wiring", () => {
  const RELEASE = readFileSync(path.join(REPO_ROOT, ".github/workflows/release.yml"), "utf8");
  const job = (id, next) => RELEASE.slice(RELEASE.indexOf(`  ${id}:`), RELEASE.indexOf(next));

  it("verify-version rejects an MSI-incompatible tag before create-release", () => {
    const body = job("verify-version", "\n  verify-supply-chain:");
    expect(body).toMatch(/node scripts\/internal\/msi-version\.mjs --check "\$\{TAG_NAME#v\}"/);
  });

  it("the Windows leg generates the wix.version fragment and passes it to the build", () => {
    const body = job("build-and-upload", "\n  agent-binaries-linux:");
    const gen = body.indexOf("scripts/internal/msi-version.mjs --config-out");
    const build = body.indexOf("- name: Build Tauri app for release");
    expect(gen).toBeGreaterThan(-1);
    expect(gen).toBeLessThan(build);
    const step = body.slice(body.lastIndexOf("- name:", gen), gen);
    expect(step).toContain("if: runner.os == 'Windows'");
    expect(body.slice(build)).toMatch(/args:.*\$\{\{ steps\.wix_version\.outputs\.config \}\}/);
  });
});
