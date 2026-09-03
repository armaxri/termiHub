import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The gate is a bash script that only ever runs on the ubuntu CI runner. These
// tests spawn `bash` directly, so they are skipped on Windows to avoid the
// Git-Bash-on-PATH flake the matrix is prone to — the two Unix legs give fully
// representative coverage of a Linux-only script.
const describeUnix = process.platform === "win32" ? describe.skip : describe;

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "pnpm-audit-prod-gate.sh");

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "termihub-audit-gate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a canned audit payload to a temp file and return its path. */
function fixture(name, contents) {
  const p = join(root, name);
  writeFileSync(p, typeof contents === "string" ? contents : JSON.stringify(contents));
  return p;
}

/** Run the gate with a canned payload injected via AUDIT_JSON_FILE. */
function runGate(jsonFile, extraEnv = {}) {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      AUDIT_JSON_FILE: jsonFile,
      // Zero backoff so the retry path does not sleep during tests.
      AUDIT_BACKOFF_SECONDS: "0",
      ...extraEnv,
    },
  });
}

describeUnix("pnpm-audit-prod-gate.sh", () => {
  it("hard-fails on a real high/critical production advisory", () => {
    const f = fixture("advisory.json", {
      advisories: { 1234: { severity: "high" } },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 1 },
        totalDependencies: 174,
      },
    });
    const r = runGate(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("2 high and 1 critical");
  });

  it("hard-fails when only a critical advisory is present", () => {
    const f = fixture("critical.json", {
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1 },
      },
    });
    expect(runGate(f).status).toBe(1);
  });

  it("passes a clean tree, ignoring lower-severity advisories", () => {
    // A lingering moderate must NOT trip the high-gate.
    const f = fixture("clean.json", {
      advisories: {},
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 },
        totalDependencies: 174,
      },
    });
    const r = runGate(f);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("clean");
  });

  it("soft-passes a registry error (empty payload) after retrying", () => {
    const f = fixture("empty.json", "");
    const r = runGate(f, { AUDIT_MAX_ATTEMPTS: "3" });
    expect(r.status).toBe(0);
    // Retried twice before the final soft-pass on attempt 3.
    expect(r.stdout).toMatch(/attempt 1\/3/);
    expect(r.stdout).toMatch(/attempt 2\/3/);
    expect(r.stdout).toContain("soft-passing");
  });

  it("soft-passes a registry error (non-JSON payload) after retrying", () => {
    const f = fixture(
      "garbage.json",
      "ERR_SOCKET_TIMEOUT request to https://registry.npmjs.org/... failed\n"
    );
    const r = runGate(f, { AUDIT_MAX_ATTEMPTS: "2" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("soft-passing");
  });
});
