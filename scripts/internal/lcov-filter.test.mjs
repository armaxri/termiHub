import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterLcov, parseArgs, relativize } from "./lcov-filter.mjs";

const ROOT = "/home/runner/work/termiHub/termiHub";
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "lcov-filter.mjs");
const record = (sf, lf, lh) => [
  "TN:",
  `SF:${sf}`,
  "DA:1,1",
  `LF:${lf}`,
  `LH:${lh}`,
  "end_of_record",
];
const lcov = (...records) => records.flat().join("\n") + "\n";

describe("relativize", () => {
  it("strips the root and refuses paths outside it", () => {
    expect(relativize(`${ROOT}/rdp-sidecar/src/main.rs`, ROOT)).toBe("rdp-sidecar/src/main.rs");
    expect(relativize("/elsewhere/rdp-sidecar/src/main.rs", ROOT)).toBeNull();
    expect(relativize("C:\\w\\t\\rdp-sidecar\\src\\a.rs", "C:\\w\\t")).toBe("rdp-sidecar/src/a.rs");
  });
});

describe("filterLcov", () => {
  const sidecarReport = lcov(
    record(`${ROOT}/rdp-sidecar/src/main.rs`, 10, 5),
    record(`${ROOT}/core/src/lib.rs`, 100, 3),
    record(`${ROOT}/rdp-sidecar/vendor/ironrdp-pdu/src/lib.rs`, 50, 1),
    record("/home/runner/.cargo/registry/src/x/lib.rs", 7, 7),
    record(`${ROOT}/rdp-sidecar/src/rdp.rs`, 20, 10)
  );

  it("keeps only the sidecar's own sources, whole records intact", () => {
    const out = filterLcov(sidecarReport, ROOT, "rdp-sidecar/", ["rdp-sidecar/vendor/"]);
    expect(out).toBe(
      lcov(
        record(`${ROOT}/rdp-sidecar/src/main.rs`, 10, 5),
        record(`${ROOT}/rdp-sidecar/src/rdp.rs`, 20, 10)
      )
    );
  });

  it("returns an empty tracefile when nothing matches", () => {
    expect(filterLcov(sidecarReport, ROOT, "plugin-api/")).toBe("");
  });
});

describe("parseArgs", () => {
  it("requires --in, --out and --keep", () => {
    expect(() => parseArgs(["--in", "a"])).toThrow(/required/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
    const o = parseArgs([
      "--in",
      "a",
      "--out",
      "b",
      "--keep",
      "x/",
      "--drop",
      "x/v/",
      "--root",
      "/r",
    ]);
    expect(o).toMatchObject({ input: "a", output: "b", keep: "x/", drop: ["x/v/"], root: "/r" });
  });
});

describe("CLI", () => {
  it("writes the filtered tracefile", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lcov-filter-"));
    const input = path.join(dir, "in.lcov");
    const output = path.join(dir, "out.lcov");
    writeFileSync(
      input,
      lcov(record(`${dir}/rdp-sidecar/src/a.rs`, 4, 2), record(`${dir}/core/src/a.rs`, 9, 9))
    );
    const stdout = execFileSync(
      "node",
      [SCRIPT, "--in", input, "--out", output, "--root", dir, "--keep", "rdp-sidecar/"],
      { encoding: "utf8" }
    );
    expect(stdout).toMatch(/kept 1 record/);
    expect(readFileSync(output, "utf8")).toBe(lcov(record(`${dir}/rdp-sidecar/src/a.rs`, 4, 2)));
  });
});
