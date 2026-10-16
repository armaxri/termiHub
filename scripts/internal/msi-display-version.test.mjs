// Tests for the Windows install smoke's exact MSI DisplayVersion gate (#4441,
// follow-up to #4283 / PKG2-003).
//
// release.yml builds the MSI with bundle.windows.wix.version from
// scripts/internal/msi-version.mjs. release-windows-smoke.yml must require the
// installed "Add/Remove Programs" DisplayVersion to equal that mapped version
// exactly, so a missing or wrong wix.version override fails the smoke. The
// smoke only runs against a published release (no version tag exists to
// dispatch it on yet), so the comparison lives in
// assert-msi-display-version.ps1 and is exercised here on a local pwsh, and the
// workflow wiring is pinned structurally.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BETA_BASE, RC_BASE, FINAL_REVISION, msiVersion } from "./msi-version.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const ASSERT = path.join(HERE, "assert-msi-display-version.ps1");
const WORKFLOWS = path.join(REPO_ROOT, ".github", "workflows");

const HAS_PWSH = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

/** Run the assert script with the given DisplayVersion and expected version. */
const assertVersion = (actual, expected) =>
  spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-File", ASSERT, "-Actual", actual, "-Expected", expected],
    { encoding: "utf8" }
  );

describe.skipIf(!HAS_PWSH)("assert-msi-display-version.ps1", () => {
  it.each([
    ["0.2.0-beta.1", `0.2.0.${BETA_BASE + 1}`],
    ["0.2.0-rc.3", `0.2.0.${RC_BASE + 3}`],
    ["0.2.0", `0.2.0.${FINAL_REVISION}`],
  ])("passes when DisplayVersion is exactly the mapped version of %s", (release, mapped) => {
    const r = assertVersion(msiVersion(release), mapped);
    expect(r.stdout).not.toContain("::error::");
    expect(r.status).toBe(0);
  });

  it("trims padding on both sides before comparing (#4879)", () => {
    const r = assertVersion(" 0.2.0.10001 ", "0.2.0.10001\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("matches the mapped MSI version 0.2.0.10001");
  });

  it.each([
    ["the bare X.Y.Z core (no wix.version override)", "0.2.0"],
    ["X.Y.Z.0", "0.2.0.0"],
    ["another prerelease revision", "0.2.0.10002"],
    ["the final revision for a beta", `0.2.0.${FINAL_REVISION}`],
    ["a revision that only shares the prefix", "0.2.0.100010"],
  ])("fails on %s", (_label, actual) => {
    const r = assertVersion(actual, "0.2.0.10001");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::installed DisplayVersion is");
    expect(r.stdout).toContain("expected '0.2.0.10001'");
  });

  it("fails on an empty DisplayVersion", () => {
    const r = assertVersion("", "0.2.0.10001");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::installed DisplayVersion is empty");
  });

  it("fails when no expected version is given", () => {
    const r = assertVersion("0.2.0.10001", " ");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::no expected MSI version");
  });
});

describe("release-windows-smoke.yml exact DisplayVersion wiring (#4441)", () => {
  const SMOKE = readFileSync(path.join(WORKFLOWS, "release-windows-smoke.yml"), "utf8");
  const job = SMOKE.slice(
    SMOKE.indexOf("\n  windows-install-smoke:"),
    SMOKE.indexOf("\n  per-machine-plugin-lpac:")
  );
  /** The body of the step named `name`, up to the next step. */
  const step = (name) => {
    const start = job.indexOf(`- name: ${name}`);
    expect(start, `step '${name}'`).toBeGreaterThan(-1);
    const next = job.indexOf("\n      - name:", start + 1);
    return job.slice(start, next === -1 ? undefined : next);
  };

  it("maps the release version with msi-version.mjs before installing", () => {
    const map = step("Map the release version to the MSI version");
    expect(map).toContain("id: msi_version");
    expect(map).toContain("VERSION: ${{ needs.resolve-tag.outputs.version }}");
    // --check first so an unsupported version's ::error annotation reaches the log.
    expect(map).toContain('node scripts/internal/msi-version.mjs --check "$VERSION"');
    expect(map).toMatch(/msi_version="\$\(node scripts\/internal\/msi-version\.mjs "\$VERSION"\)"/);
    expect(map).toContain('echo "msi_version=$msi_version" >> "$GITHUB_OUTPUT"');
    expect(job.indexOf("- name: Map the release version")).toBeLessThan(
      job.indexOf("- name: Install MSI silently")
    );
  });

  it("asserts the downloaded MSI's ProductVersion before installing it", () => {
    const check = step("Check the MSI ProductVersion is the mapped version");
    expect(check).toContain("MSI_VERSION: ${{ steps.msi_version.outputs.msi_version }}");
    expect(check).toContain(
      "./scripts/internal/msi-product-version.ps1 -Msi $env:MSI -Expected $env:MSI_VERSION"
    );
    expect(job.indexOf("- name: Check the MSI ProductVersion")).toBeLessThan(
      job.indexOf("- name: Install MSI silently")
    );
  });

  it("requires the installed DisplayVersion to equal the mapped version exactly", () => {
    const install = step("Install MSI silently");
    expect(install).toContain("MSI_VERSION: ${{ steps.msi_version.outputs.msi_version }}");
    expect(install).toContain(
      './scripts/internal/assert-msi-display-version.ps1 -Actual "$($entry.DisplayVersion)" -Expected $env:MSI_VERSION'
    );
    expect(install).toMatch(
      /assert-msi-display-version\.ps1[^\n]*\n\s+if \(\$LASTEXITCODE -ne 0\) \{ exit 1 \}/
    );
    // The old core/prefix match let a missing or wrong wix.version pass.
    expect(install).not.toMatch(/StartsWith\("\$core\."\)/);
    expect(install).not.toContain("$core");
  });

  it("checks out the scripts the gate runs", () => {
    const checkout = step("Checkout code");
    expect(checkout).toMatch(/sparse-checkout: \|\n\s+scripts\/internal\n/);
  });
});

describe("release-windows-arm64-smoke.yml installs no MSI (#4441)", () => {
  const ARM = readFileSync(path.join(WORKFLOWS, "release-windows-arm64-smoke.yml"), "utf8");

  it("only runs the agent binary, so it has no DisplayVersion to gate", () => {
    expect(ARM).not.toMatch(/msiexec|\.msi\b|DisplayVersion/i);
  });
});
