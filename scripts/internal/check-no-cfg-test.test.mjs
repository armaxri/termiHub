import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import path from "path";
import {
  checkRepo,
  findCfgTest,
  isTestFile,
  stripCommentsAndStrings,
} from "./check-no-cfg-test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("isTestFile", () => {
  it("recognizes test files and test directories", () => {
    expect(isTestFile("src-tauri/src/backup/tests.rs")).toBe(true);
    expect(isTestFile("src-tauri/src/backup/tests_deferred_import.rs")).toBe(false);
    expect(isTestFile("src-tauri/src/connection/manager_credential_scope_tests.rs")).toBe(true);
    expect(isTestFile("core/tests/ssh.rs")).toBe(true);
    expect(isTestFile("src-tauri/src/x/test_support/mod.rs")).toBe(true);
    expect(isTestFile("src-tauri/src/credential/os_keychain.rs")).toBe(false);
  });
});

describe("findCfgTest", () => {
  it("finds cfg!(test) predicates with their enclosing fn", () => {
    const src = [
      "fn a() -> bool {",
      "    cfg!(test)",
      "}",
      'fn b() -> bool { cfg!(any(test, feature = "x")) || cfg!(not(test)) }',
      'fn c() -> bool { cfg!(windows) || cfg!(feature = "test-hooks") }',
    ].join("\n");
    expect(findCfgTest(src)).toEqual([
      { line: 2, fn: "a", predicate: "test" },
      { line: 4, fn: "b", predicate: 'any(test, feature = "x")' },
      { line: 4, fn: "b", predicate: "not(test)" },
    ]);
  });

  it("ignores comments, strings and inline test modules", () => {
    const src = [
      "// cfg!(test) in a comment",
      "/* cfg!(test) */",
      'const S: &str = "cfg!(test)";',
      "#[cfg(test)]",
      "mod tests {",
      "    fn t() { let _ = '{'; assert!(cfg!(test)); }",
      "}",
      "#[cfg(test)]",
      "pub(crate) mod test_support { fn u() -> bool { cfg!(test) } }",
      "fn after() -> bool { cfg!(test) }",
    ].join("\n");
    expect(findCfgTest(src)).toEqual([{ line: 10, fn: "after", predicate: "test" }]);
  });

  it("keeps line numbers when blanking", () => {
    const src = '/* a\nb */ "x\ny" r#"z\n"# done';
    expect(stripCommentsAndStrings(src).split("\n")).toHaveLength(src.split("\n").length);
  });
});

describe("checkRepo", () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  const repo = (files) => {
    dir = mkdtempSync(path.join(tmpdir(), "no-cfg-test-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    }
    return dir;
  };
  const allowed = [{ file: "a/src/lib.rs", fn: "skip", reason: "documented" }];

  it("passes allow-listed uses and test files", () => {
    const root = repo({
      "a/src/lib.rs": "fn skip() -> bool { cfg!(test) }",
      "a/src/lib_tests.rs": "fn x() -> bool { cfg!(test) }",
      "target/debug/build/gen.rs": "fn y() -> bool { cfg!(test) }",
    });
    expect(checkRepo(root, allowed).problems).toEqual([]);
  });

  it("fails on a new use and on a stale allow-list entry", () => {
    const root = repo({ "b/src/store.rs": "fn new() -> Self {\n    let s = !cfg!(test);\n}" });
    const { problems } = checkRepo(root, allowed);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^b\/src\/store\.rs:2: `cfg!\(test\)` in non-test code \(fn new\)/);
    expect(problems[1]).toMatch(/stale allow-list entry a\/src\/lib\.rs/);
  });

  it("the real repo has no cfg!(test) outside the documented exceptions", () => {
    expect(checkRepo(ROOT).problems).toEqual([]);
  });
});
