import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import path from "path";
import {
  checkRepo,
  findIgnores,
  inventoryRows,
  jobBlock,
  laneSelects,
  parseBindings,
  readStringLiteral,
} from "./check-ignored-tests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("readStringLiteral", () => {
  it("decodes escapes and line continuations", () => {
    const text = '"a \\"b\\"; \\\n        c"';
    expect(readStringLiteral(text, 0)).toEqual({ value: 'a "b"; c', end: text.length });
  });

  it("reads raw strings and rejects a non-literal", () => {
    expect(readStringLiteral('r#"x "y" z"#', 0).value).toBe('x "y" z');
    expect(readStringLiteral("x", 0)).toBeNull();
  });
});

describe("findIgnores", () => {
  it("finds bare, reasoned and cfg_attr ignores with their test fn", () => {
    const text = [
      "#[test]",
      "#[ignore]",
      "fn bare() {}",
      "#[tokio::test]",
      '#[ignore = "why; \\',
      '            lane: a.yml#b"]',
      "async fn reasoned() {}",
      "#[test]",
      "#[cfg_attr(",
      "    windows,",
      '    ignore = "flaky (see #2495); quarantine: #2495"',
      ")]",
      "fn quarantined() {}",
    ].join("\n");
    expect(findIgnores(text)).toEqual([
      { line: 2, test: "bare", reason: null },
      { line: 5, test: "reasoned", reason: "why; lane: a.yml#b" },
      { line: 9, test: "quarantined", reason: "flaky (see #2495); quarantine: #2495" },
    ]);
  });

  it("skips comments and cfg_attr without ignore", () => {
    const text = [
      "// the `#[ignore]`'d live test",
      '#[cfg_attr(not(test), expect(dead_code, reason = "ignore me"))]',
      "fn kept() {}",
    ].join("\n");
    expect(findIgnores(text)).toEqual([]);
  });
});

describe("parseBindings", () => {
  it("reads every binding kind and ignores bare issue mentions", () => {
    expect(
      parseBindings(
        "x (#4818); lane: w.yml#job-1; manual: MT-RUST-01; quarantine: #2495; helper: parent"
      )
    ).toEqual({
      lanes: ["w.yml#job-1"],
      manual: ["MT-RUST-01"],
      quarantine: ["2495"],
      helpers: ["parent"],
    });
    expect(parseBindings("needs a host (#4818, nightly lane)")).toEqual({
      lanes: [],
      manual: [],
      quarantine: [],
      helpers: [],
    });
  });
});

describe("jobBlock / laneSelects", () => {
  const wf = [
    "on: push",
    "jobs:",
    "  a:",
    "    steps:",
    "      - run: cargo test -- --ignored x",
    "  # a comment between jobs",
    "  b:",
    "    steps: []",
  ].join("\n");

  it("cuts one job out of a workflow", () => {
    expect(jobBlock(wf, "a")).toContain("--ignored x");
    expect(jobBlock(wf, "a")).not.toContain("  b:");
    expect(jobBlock(wf, "c")).toBeNull();
  });

  it("matches a test by name or by its test binary", () => {
    expect(laneSelects("cargo test my_test -- --ignored", "core/src/a.rs", "my_test")).toBe(true);
    expect(laneSelects("--test docker_it -- --ignored", "agent/tests/docker_it.rs", "t")).toBe(
      true
    );
    expect(laneSelects("--test other -- --ignored", "agent/tests/docker_it.rs", "t")).toBe(false);
  });
});

describe("inventoryRows", () => {
  it("reads the rows between the markers", () => {
    const docs = [
      "| `x.rs` | `outside` |",
      "<!-- ignored-tests:begin -->",
      "| File | Test |",
      "| `a/b.rs` | `t1` | why | lane |",
      "<!-- ignored-tests:end -->",
    ].join("\n");
    expect([...inventoryRows(docs)]).toEqual(["a/b.rs::t1"]);
    expect(inventoryRows("no markers")).toBeNull();
  });
});

describe("checkRepo", () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const repo = (files) => {
    dir = mkdtempSync(path.join(tmpdir(), "ignored-tests-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    }
    return dir;
  };
  const lanes = {
    "w.yml#runs": {},
    "w.yml#lint": {},
    "w.yml#scripted": { via: ["scripts/run.sh"] },
  };
  const workflow = [
    "jobs:",
    "  runs:",
    "    steps:",
    "      - run: cargo test -p c -- --ignored --exact good",
    "  lint:",
    "    steps:",
    "      # cargo test -- --ignored (a comment does not count)",
    "      - run: cargo test lint_only",
    "  scripted:",
    "    steps:",
    "      - run: ./scripts/run.sh",
  ].join("\n");
  const docs = (...tests) =>
    [
      "MT-RUST-01 defined here.",
      "<!-- ignored-tests:begin -->",
      ...tests.map((t) => `| \`c/src/lib.rs\` | \`${t}\` | why | binding |`),
      "<!-- ignored-tests:end -->",
    ].join("\n");
  const src = (...attrs) =>
    attrs.map(([reason, test]) => `#[test]\n#[ignore = "${reason}"]\nfn ${test}() {}\n`).join("");

  it("passes lane, script lane, manual, quarantine and helper bindings", () => {
    const root = repo({
      ".github/workflows/w.yml": workflow,
      "scripts/run.sh": "cargo test -- --ignored --exact via_script\n",
      "c/src/lib.rs":
        src(
          ["x; lane: w.yml#runs", "good"],
          ["x; lane: w.yml#scripted", "via_script"],
          ["x; manual: MT-RUST-01", "by_hand"],
          ["x; quarantine: #2495", "flaky"],
          ["x; helper: parent", "child"]
        ) + 'fn parent() { cmd.args(["child", "--ignored"]); }\n',
      "docs/testing.md": docs("good", "via_script", "by_hand", "flaky", "child"),
    });
    expect(checkRepo(root, lanes).problems).toEqual([]);
  });

  it("fails every kind of unbound or broken binding and a drifted inventory", () => {
    const root = repo({
      ".github/workflows/w.yml": workflow,
      "c/src/lib.rs":
        "#[test]\n#[ignore]\nfn bare() {}\n" +
        src(
          ["nightly lane only (#4818)", "unbound"],
          ["x; lane: w.yml#nope", "unregistered"],
          ["x; lane: w.yml#lint", "lint_only"],
          ["x; lane: w.yml#runs", "renamed"],
          ["x; manual: MT-RUST-99", "undefined_id"],
          ["x; helper: missing_parent", "orphan"]
        ),
      "docs/testing.md": docs("bare", "unbound", "unregistered", "lint_only", "renamed", "gone"),
    });
    const problems = checkRepo(root, lanes).problems.join("\n");
    expect(problems).toMatch(/\(bare\): bare #\[ignore\]/);
    expect(problems).toMatch(/\(unbound\): the reason names no/);
    expect(problems).toMatch(/\(unregistered\): lane w\.yml#nope is not in the LANES registry/);
    expect(problems).toMatch(/\(lint_only\): lane w\.yml#lint: never runs ignored tests/);
    expect(problems).toMatch(/\(renamed\): lane w\.yml#runs never names this test/);
    expect(problems).toMatch(/\(undefined_id\): manual id MT-RUST-99 is not defined/);
    expect(problems).toMatch(/\(orphan\): helper parent missing_parent is not in this file/);
    expect(problems).toMatch(/inventory table is missing c\/src\/lib\.rs::undefined_id/);
    expect(problems).toMatch(/stale inventory row c\/src\/lib\.rs::gone/);
  });

  it("the real repo binds every ignored test", () => {
    const { problems, ignores } = checkRepo(ROOT);
    expect(problems).toEqual([]);
    expect(ignores.length).toBeGreaterThan(0);
  });
});
