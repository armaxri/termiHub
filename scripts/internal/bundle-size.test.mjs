import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGET_BYTES, dirSize, evaluate, parseArgs } from "./bundle-size.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "bundle-size.mjs");
const MIB = 1024 * 1024;

/** A fake dist/ holding `bytes` bytes split across a nested tree. */
function fakeDist(bytes) {
  const dir = mkdtempSync(path.join(tmpdir(), "bundle-size-"));
  mkdirSync(path.join(dir, "assets"));
  const half = Math.floor(bytes / 2);
  writeFileSync(path.join(dir, "index.html"), Buffer.alloc(bytes - half));
  writeFileSync(path.join(dir, "assets", "app.js"), Buffer.alloc(half));
  return dir;
}

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("dirSize", () => {
  it("sums files recursively", () => {
    expect(dirSize(fakeDist(3000))).toBe(3000);
  });
});

describe("evaluate", () => {
  it("passes at or under the budget with no annotation", () => {
    const r = evaluate(10 * MIB, 10 * MIB);
    expect(r.ok).toBe(true);
    expect(r.annotation).toBeNull();
    expect(r.lines.join("\n")).toContain("OK (0.00 MiB headroom)");
  });

  it("fails over the budget with an ::error annotation", () => {
    const r = evaluate(12 * MIB, 10 * MIB);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("OVER BUDGET by 2.00 MiB");
    expect(r.annotation).toMatch(/^::error title=Bundle over budget::/);
  });
});

describe("parseArgs", () => {
  it("defaults to the repo dist/ and the committed budget", () => {
    const opts = parseArgs([]);
    expect(opts.budget).toBe(BUDGET_BYTES);
    expect(path.basename(opts.dist)).toBe("dist");
  });

  it("rejects an unknown flag and a bad budget", () => {
    expect(() => parseArgs(["--nope"])).toThrow();
    expect(() => parseArgs(["--budget-mib", "0"])).toThrow();
  });
});

describe("CLI", () => {
  it("exits 0 within budget", () => {
    const r = run("--dist", fakeDist(1000), "--budget-mib", "1");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("status:      OK");
    expect(r.stderr).not.toContain("::error");
  });

  it("exits 1 with an ::error annotation over budget", () => {
    const r = run("--dist", fakeDist(2 * MIB), "--budget-mib", "1");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("OVER BUDGET by 1.00 MiB");
    expect(r.stderr).toContain("::error title=Bundle over budget::");
  });

  it("exits 0 when dist/ is missing (the build lanes own build failures)", () => {
    const missing = path.join(tmpdir(), "bundle-size-does-not-exist");
    const r = run("--dist", missing);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("not found");
  });
});
