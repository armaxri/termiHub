import { describe, it, expect } from "vitest";
import { classify, allAreas, testMatrix, formatOutputs } from "./ci-changes.mjs";

const on = (flags) => Object.keys(flags).filter((k) => flags[k]);

describe("classify", () => {
  it("runs nothing for an audit-notes-only PR (#2726)", () => {
    expect(on(classify(["audit/2026-09/notes.md", "audit/findings.json"]))).toEqual([]);
  });

  it("runs only the markdown checks for a docs-only PR", () => {
    expect(on(classify(["docs/contributing.md", "README.md", "docs/concepts/x.html"]))).toEqual([
      "markdown",
    ]);
  });

  it("treats a frontend-only PR as frontend (no Rust)", () => {
    expect(on(classify(["src/components/Foo.tsx", "src/store/appStore.ts"]))).toEqual(["frontend"]);
  });

  it("treats a Rust-only PR as rust (no frontend)", () => {
    expect(on(classify(["core/src/lib.rs", "src-tauri/tauri.conf.json"]))).toEqual(["rust"]);
  });

  it("flags lockfile and manifest changes as deps", () => {
    expect(classify(["Cargo.lock"])).toMatchObject({ rust: true, deps: true });
    expect(classify(["core/Cargo.toml"])).toMatchObject({ rust: true, deps: true });
    expect(classify(["pnpm-lock.yaml"])).toMatchObject({ frontend: true, deps: true });
  });

  it("keeps the sidecar lockfile to the sidecar job", () => {
    expect(on(classify(["rdp-sidecar/Cargo.lock", "rdp-sidecar/src/main.rs"]))).toEqual([
      "sidecar",
    ]);
  });

  it("maps ts-rs generated types to both rust and frontend", () => {
    expect(classify(["src/types/generated/Foo.ts"])).toMatchObject({ rust: true, frontend: true });
  });

  it("routes scripts by kind", () => {
    expect(on(classify(["scripts/dev.sh"]))).toEqual(["scripts"]);
    expect(on(classify(["scripts/hooks/pre-push"]))).toEqual(["scripts"]);
    expect(on(classify(["scripts/internal/parse-issue-refs.mjs"]))).toEqual(["frontend"]);
    expect(on(classify(["scripts/check-testid-drift.py"]))).toEqual(["harness"]);
    expect(classify(["scripts/package-plugin.sh"])).toMatchObject({ rust: true, scripts: true });
  });

  it("adds scripts for any shell script, wherever it lives", () => {
    expect(classify(["agent/docker/entrypoint.sh"])).toMatchObject({ rust: true, scripts: true });
    expect(on(classify(["tests/docker/ssh/setup.sh"]))).toEqual(["scripts"]);
  });

  it("maps the Python harness to harness", () => {
    expect(on(classify(["tests/system/tests/test_x.py"]))).toEqual(["harness"]);
  });

  it("fails open on CI plumbing", () => {
    expect(classify([".github/workflows/code-quality.yml"])).toEqual(allAreas());
    expect(classify([".github/actions/setup-pnpm/action.yml"])).toEqual(allAreas());
  });

  it("fails open on an unrecognised path", () => {
    expect(classify(["brand-new-dir/thing.bin"])).toEqual(allAreas());
    expect(classify(["docs/a.md", ".gitattributes"])).toEqual(allAreas());
  });

  it("ignores blank lines and normalises backslashes", () => {
    expect(on(classify(["", "  ", "src\\main.tsx"]))).toEqual(["frontend"]);
  });
});

describe("testMatrix", () => {
  it("is the full OS set post-merge", () => {
    expect(testMatrix(classify(["docs/a.md"]), false)).toEqual([
      "ubuntu-latest",
      "windows-latest",
      "macos-latest",
    ]);
  });

  it("runs ubuntu + windows for Rust PRs, never macOS", () => {
    expect(testMatrix(classify(["core/src/lib.rs"]), true)).toEqual([
      "ubuntu-latest",
      "windows-latest",
    ]);
  });

  it("runs only ubuntu for frontend-only PRs", () => {
    expect(testMatrix(classify(["src/main.tsx"]), true)).toEqual(["ubuntu-latest"]);
  });

  it("is empty for docs-only PRs", () => {
    expect(testMatrix(classify(["docs/a.md"]), true)).toEqual([]);
  });
});

describe("formatOutputs", () => {
  it("emits one key=value line per area plus the matrix", () => {
    const out = formatOutputs(classify(["src/main.tsx"]), true);
    expect(out).toContain("frontend=true\n");
    expect(out).toContain("rust=false\n");
    expect(out).toContain('test_matrix=["ubuntu-latest"]\n');
  });
});
