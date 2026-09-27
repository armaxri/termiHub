import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MARKER_RE,
  findMarkers,
  scanTree,
  parseAllowlist,
  evaluateMarkers,
  formatReport,
  runScan,
  parseArgs,
} from "./release-marker-scan.mjs";

function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "marker-scan-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

describe("MARKER_RE", () => {
  it.each([
    "// TODO: later",
    "  // FIXME broken",
    "/* HACK */",
    " * TODO continue",
    "//! TODO doc",
    "/// FIXME doc",
    "/** HACK */",
    "let x = 1; // TODO trailing",
  ])("matches a comment marker: %s", (line) => {
    expect(MARKER_RE.test(line)).toBe(true);
  });

  it.each([
    'placeholder="e.g. TODO markers"',
    'expect(x).toBe("TODO");',
    '"\\\\b(?:TODO|FIXME)\\\\b"',
    "// TODOS is not the marker word",
    "// mentions a todo in lowercase",
  ])("ignores a non-marker mention: %s", (line) => {
    expect(MARKER_RE.test(line)).toBe(false);
  });
});

describe("findMarkers", () => {
  it("reports path, 1-based line, marker word and trimmed text", () => {
    const text = "fn a() {}\r\n    // FIXME: race\nfn b() {}\n";
    expect(findMarkers(text, "core/src/a.rs")).toEqual([
      { path: "core/src/a.rs", line: 2, marker: "FIXME", text: "// FIXME: race" },
    ]);
  });
});

describe("scanTree", () => {
  it("scans .ts/.tsx/.rs under the roots and skips build/vendor dirs", () => {
    const root = tree({
      "src/a.ts": "// TODO a\n",
      "src/b.tsx": "const s = 'TODO';\n",
      "src/notes.md": "// TODO not scanned\n",
      "core/src/lib.rs": "/* HACK */\n",
      "core/src/target/gen.rs": "// TODO generated\n",
      "src/node_modules/x/index.ts": "// TODO dep\n",
      "other/c.ts": "// TODO outside roots\n",
    });
    const found = scanTree(root).map((m) => `${m.path}:${m.marker}`);
    expect(found).toEqual(["src/a.ts:TODO", "core/src/lib.rs:HACK"]);
  });

  it("tolerates a missing scan root", () => {
    const root = tree({ "src/a.ts": "" });
    expect(scanTree(root, { roots: ["src", "does/not/exist"] })).toEqual([]);
  });
});

describe("parseAllowlist", () => {
  it("rejects a document without an entries array", () => {
    expect(parseAllowlist({}).errors).toHaveLength(1);
    expect(parseAllowlist(null).errors).toHaveLength(1);
  });

  it("requires path, contains and a non-empty reason", () => {
    const { entries, errors } = parseAllowlist({
      entries: [
        { path: "a.rs", contains: "x", reason: "kept" },
        { path: "b.rs", contains: "y", reason: "  " },
        { path: "c.rs" },
        "nope",
      ],
    });
    expect(entries).toEqual([{ path: "a.rs", contains: "x", reason: "kept" }]);
    expect(errors).toEqual([
      "entries[1]: needs a non-empty reason",
      "entries[2]: needs a non-empty contains, reason",
      "entries[3]: must be an object",
    ]);
  });
});

describe("evaluateMarkers", () => {
  const markers = [
    { path: "src/a.ts", line: 1, marker: "TODO", text: "// TODO keep me" },
    { path: "src/b.ts", line: 4, marker: "FIXME", text: "// FIXME new" },
  ];

  it("blocks an un-allowlisted marker", () => {
    const v = evaluateMarkers(markers, [{ path: "src/a.ts", contains: "keep me", reason: "r" }]);
    expect(v.ok).toBe(false);
    expect(v.blocking.map((m) => m.path)).toEqual(["src/b.ts"]);
    expect(v.allowed.map((m) => m.path)).toEqual(["src/a.ts"]);
  });

  it("does not let an entry for one file allow the same text in another", () => {
    const v = evaluateMarkers(markers, [{ path: "src/a.ts", contains: "//", reason: "r" }]);
    expect(v.blocking.map((m) => m.path)).toEqual(["src/b.ts"]);
  });

  it("fails on a stale entry that matches nothing", () => {
    const v = evaluateMarkers(
      [markers[0]],
      [
        { path: "src/a.ts", contains: "keep me", reason: "r" },
        { path: "src/gone.ts", contains: "old", reason: "r" },
      ]
    );
    expect(v.blocking).toEqual([]);
    expect(v.stale).toEqual([{ path: "src/gone.ts", contains: "old", reason: "r" }]);
    expect(v.ok).toBe(false);
  });

  it("passes when every marker is allowlisted and no entry is stale", () => {
    const v = evaluateMarkers(markers, [
      { path: "src/a.ts", contains: "keep me", reason: "r" },
      { path: "src/b.ts", contains: "FIXME new", reason: "r" },
    ]);
    expect(v.ok).toBe(true);
  });
});

describe("formatReport", () => {
  it("prints remediation on failure", () => {
    const v = evaluateMarkers(
      [{ path: "src/b.ts", line: 4, marker: "FIXME", text: "// FIXME" }],
      []
    );
    const out = formatReport(v, { allowlistPath: "allow.json" }).join("\n");
    expect(out).toContain("FAIL: src/b.ts:4: // FIXME");
    expect(out).toContain("add an entry with a written reason to allow.json");
  });

  it("fails on allowlist errors even with no markers", () => {
    const v = evaluateMarkers([], []);
    const out = formatReport(v, { allowlistPath: "a.json", errors: ["bad"] });
    expect(out[0]).toBe("FAIL: a.json: bad");
    expect(out.join("\n")).not.toContain("No un-allowlisted");
  });
});

describe("runScan", () => {
  const allow = (entries) => JSON.stringify({ entries });

  it("exits 0 when clean", () => {
    const root = tree({ "src/a.ts": "// fine\n", "allow.json": allow([]) });
    expect(runScan({ repoRoot: root, allowlistPath: "allow.json", log: () => {} })).toBe(0);
  });

  it("exits 1 on an un-allowlisted marker", () => {
    const root = tree({ "src/a.ts": "// TODO x\n", "allow.json": allow([]) });
    const lines = [];
    expect(
      runScan({ repoRoot: root, allowlistPath: "allow.json", log: (l) => lines.push(l) })
    ).toBe(1);
    expect(lines[0]).toBe("FAIL: src/a.ts:1: // TODO x");
  });

  it("exits 1 on an invalid allowlist entry", () => {
    const root = tree({ "allow.json": allow([{ path: "src/a.ts" }]) });
    expect(runScan({ repoRoot: root, allowlistPath: "allow.json", log: () => {} })).toBe(1);
  });

  it("exits 2 when the allowlist is missing or not JSON", () => {
    const root = tree({ "bad.json": "{" });
    expect(runScan({ repoRoot: root, allowlistPath: "missing.json", log: () => {} })).toBe(2);
    expect(runScan({ repoRoot: root, allowlistPath: "bad.json", log: () => {} })).toBe(2);
  });
});

describe("parseArgs", () => {
  it("accepts --root and --allowlist", () => {
    expect(parseArgs(["--root", "r", "--allowlist", "a.json"])).toEqual({
      root: "r",
      allowlist: "a.json",
    });
  });

  it("rejects unknown flags and missing values", () => {
    expect(parseArgs(["--nope"])).toBeNull();
    expect(parseArgs(["--root"])).toBeNull();
  });
});

describe("the committed allowlist", () => {
  it("passes against this repository", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const lines = [];
    expect(runScan({ repoRoot, log: (l) => lines.push(l) }), lines.join("\n")).toBe(0);
  });
});
