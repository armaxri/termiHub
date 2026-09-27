import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  componentFor,
  tallyLcov,
  percentages,
  check,
  updatedBaseline,
  parseArgs,
} from "./coverage-ratchet.mjs";
import { corruptProfraws } from "./llvm-cov-report.mjs";

const ROOT = "/home/runner/work/termiHub/termiHub";
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "coverage-ratchet.mjs");

const record = (sf, lf, lh) => ["TN:", `SF:${sf}`, `LF:${lf}`, `LH:${lh}`, "end_of_record"];
const lcov = (...records) => records.flat().join("\n") + "\n";

describe("componentFor", () => {
  it("maps repo-relative and absolute paths to their component", () => {
    expect(componentFor("src/App.tsx", ROOT)).toBe("frontend");
    expect(componentFor(`${ROOT}/core/src/lib.rs`, ROOT)).toBe("core");
    expect(componentFor(`${ROOT}/agent/src/main.rs`, ROOT)).toBe("agent");
    expect(componentFor(`${ROOT}/src-tauri/src/lib.rs`, ROOT)).toBe("src-tauri");
  });

  it("does not misfile nested dirs that share a component name", () => {
    expect(componentFor(`${ROOT}/core/src/agent/mod.rs`, ROOT)).toBe("core");
    expect(componentFor(`${ROOT}/src-tauri/src/core/x.rs`, ROOT)).toBe("src-tauri");
  });

  it("returns null for ungated workspace members and paths outside the root", () => {
    expect(componentFor(`${ROOT}/plugin-api/src/lib.rs`, ROOT)).toBeNull();
    expect(componentFor(`${ROOT}/vendor/vnc-rs/src/lib.rs`, ROOT)).toBeNull();
    expect(componentFor("/elsewhere/core/src/lib.rs", ROOT)).toBeNull();
  });

  it("handles Windows paths", () => {
    expect(componentFor("C:\\w\\termiHub\\core\\src\\lib.rs", "C:\\w\\termiHub")).toBe("core");
  });
});

describe("tallyLcov / percentages", () => {
  it("sums per component and counts ungated files in unified only", () => {
    const fe = lcov(record("src/a.ts", 10, 5));
    const rust = lcov(
      record(`${ROOT}/core/src/a.rs`, 100, 90),
      record(`${ROOT}/plugin-api/src/lib.rs`, 10, 10)
    );
    const pct = percentages(tallyLcov([fe, rust], ROOT));
    expect(pct.frontend).toBe(50);
    expect(pct.core).toBe(90);
    expect(pct.agent).toBeNull();
    expect(pct.unified).toBeCloseTo((105 * 100) / 120);
  });
});

describe("check", () => {
  const base = { frontend: 80, core: 90 };

  it("passes within the tolerance and fails beyond it", () => {
    expect(check({ frontend: 79.8, core: 90 }, base, 0.25).ok).toBe(true);
    const res = check({ frontend: 79.7, core: 90 }, base, 0.25);
    expect(res.ok).toBe(false);
    expect(res.rows.find((r) => r.component === "frontend").status).toBe("FAIL");
  });

  it("fails when a baselined component has no data", () => {
    const res = check({ frontend: 85, core: null }, base, 0.25);
    expect(res.ok).toBe(false);
    expect(res.rows.find((r) => r.component === "core").status).toBe("MISSING");
  });

  it("hints to raise the baseline on a clear improvement", () => {
    const res = check({ frontend: 81, core: 90 }, base, 0.25);
    expect(res.ok).toBe(true);
    expect(res.rows[0].status).toMatch(/raise baseline/);
  });
});

describe("updatedBaseline", () => {
  it("rounds down, raises, and never lowers without allowDecrease", () => {
    const cur = { frontend: 81.239, core: 89, agent: null };
    expect(updatedBaseline(cur, { frontend: 80, core: 90 })).toEqual({ frontend: 81.23, core: 90 });
    expect(updatedBaseline(cur, { core: 90 }, true)).toEqual({ frontend: 81.23, core: 89 });
  });
});

describe("parseArgs", () => {
  it("defaults to check mode on the two unit lcovs", () => {
    const o = parseArgs([]);
    expect(o.mode).toBe("check");
    expect(o.lcovs).toEqual(["coverage/lcov.info", "coverage-unified/rust.lcov"]);
  });
  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
  });
});

describe("CLI", () => {
  function setup() {
    const dir = mkdtempSync(path.join(tmpdir(), "ratchet-"));
    writeFileSync(path.join(dir, "fe.lcov"), lcov(record("src/a.ts", 100, 80)));
    writeFileSync(path.join(dir, "rs.lcov"), lcov(record(`${dir}/core/src/a.rs`, 100, 90)));
    const run = (...args) =>
      execFileSync(
        "node",
        [
          SCRIPT,
          "--root",
          dir,
          "--platform",
          "linux",
          "--baseline",
          path.join(dir, "b.json"),
          "--lcov",
          path.join(dir, "fe.lcov"),
          "--lcov",
          path.join(dir, "rs.lcov"),
          ...args,
        ],
        { encoding: "utf8", stdio: "pipe" }
      );
    return { dir, run };
  }

  it("fails without a baseline, records one with --update, then passes", () => {
    const { dir, run } = setup();
    expect(() => run("--check")).toThrow();
    run("--update");
    const doc = JSON.parse(readFileSync(path.join(dir, "b.json"), "utf8"));
    expect(doc.platforms.linux).toMatchObject({ frontend: 80, core: 90, unified: 85 });
    expect(run("--check")).toMatch(/PASS/);
  });

  it("exits non-zero on a drop beyond the tolerance", () => {
    const { dir, run } = setup();
    run("--update");
    writeFileSync(path.join(dir, "fe.lcov"), lcov(record("src/a.ts", 100, 79)));
    expect(() => run("--check")).toThrow(/FAIL/);
  });
});

describe("llvm-cov-report corruptProfraws", () => {
  it("extracts the corrupt profile named by llvm-profdata", () => {
    const stderr = [
      "warning: /t/llvm-cov-target/termiHub-34415-1843_0.profraw: invalid instrumentation profile data (file header is corrupt)",
      "error: no profile can be merged",
    ].join("\n");
    expect(corruptProfraws(stderr)).toEqual(["/t/llvm-cov-target/termiHub-34415-1843_0.profraw"]);
  });
  it("returns nothing for unrelated failures", () => {
    expect(corruptProfraws("error: failed to find llvm-tools")).toEqual([]);
  });
});
