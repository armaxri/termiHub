import { describe, it, expect } from "vitest";
import {
  classify,
  allAreas,
  testMatrix,
  formatOutputs,
  findCommentOnlyRust,
  isNarrowableRustSource,
} from "./ci-changes.mjs";

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

  it("runs only the markdown checks for a markdownlint-config-only PR", () => {
    expect(on(classify([".markdownlint.jsonc"]))).toEqual(["markdown"]);
  });

  it("treats a frontend-only PR as frontend (no Rust)", () => {
    expect(on(classify(["src/components/Foo.tsx", "src/store/appStore.ts"]))).toEqual(["frontend"]);
  });

  it("treats a Rust-only PR as rust (no frontend)", () => {
    expect(on(classify(["src-tauri/src/lib.rs"]))).toEqual(["rust", "rustdoc"]);
  });

  it("flags agent for anything the agent binary builds from (#3615)", () => {
    expect(on(classify(["agent/src/main.rs"]))).toEqual(["rust", "agent", "rustdoc"]);
    expect(on(classify(["core/src/lib.rs"]))).toEqual(["rust", "agent", "rustdoc"]);
    expect(on(classify(["agent/tests/local_agent_integration.rs"]))).toEqual([
      "rust",
      "agent",
      "rustdoc",
    ]);
    expect(on(classify(["vendor/vnc-rs/src/lib.rs"]))).toEqual(["rust", "agent", "rustdoc"]);
    expect(on(classify(["plugin-api/src/lib.rs"]))).toEqual(["rust", "agent", "rustdoc"]);
    expect(on(classify(["rust-toolchain.toml"]))).toEqual(["rust", "agent", "rustdoc"]);
    expect(classify(["Cargo.lock"])).toMatchObject({ rust: true, deps: true, agent: true });
  });

  it("does not flag agent for Rust the agent does not build from", () => {
    expect(classify(["src-tauri/src/lib.rs"]).agent).toBe(false);
    expect(classify(["examples/plugin/src/lib.rs"]).agent).toBe(false);
    expect(classify(["core/Cargo.toml"]).agent).toBe(true);
  });

  it("runs the Rust and agent test legs when the Rust test driver changes", () => {
    expect(on(classify(["scripts/internal/ci-rust-tests.sh"]))).toEqual([
      "rust",
      "scripts",
      "agent",
      "rustdoc",
    ]);
  });

  it("runs the frontend suite for Tauri config changes — the CSP guard is vitest (#3627)", () => {
    for (const conf of ["src-tauri/tauri.conf.json", "src-tauri/tauri.windows.conf.json"]) {
      expect(on(classify([conf]))).toEqual(["rust", "frontend", "rustdoc"]);
    }
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
    expect(on(classify(["scripts/internal/ci-changes.mjs"]))).toEqual(["frontend"]);
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

  it("runs the harness contract test when the in-app test bridge changes", () => {
    expect(on(classify(["src/testbridge/protocol.ts"]))).toEqual(["frontend", "harness"]);
  });

  it("fails open on CI plumbing", () => {
    expect(classify([".github/workflows/code-quality.yml"])).toEqual(allAreas());
    expect(classify([".github/actions/setup-pnpm/action.yml"])).toEqual(allAreas());
  });

  it("runs actionlint only when CI plumbing changes (#3327)", () => {
    expect(classify([".github/workflows/agent.yml"]).workflows).toBe(true);
    expect(classify(["src/main.tsx", "core/src/lib.rs", "docs/a.md"]).workflows).toBe(false);
    expect(classify(["scripts/dev.sh"]).workflows).toBe(false);
  });

  it("fails open on an unrecognised path", () => {
    expect(classify(["brand-new-dir/thing.bin"])).toEqual(allAreas());
    expect(classify(["docs/a.md", ".gitattributes"])).toEqual(allAreas());
  });

  it("ignores blank lines and normalises backslashes", () => {
    expect(on(classify(["", "  ", "src\\main.tsx"]))).toEqual(["frontend"]);
  });
});

describe("comment-only Rust changes (#3903)", () => {
  const commentOnly = new Set(["core/src/backends/ssh/unattended.rs"]);

  it("narrows a comment-only Rust PR to fmt + rustdoc", () => {
    const flags = classify(["core/src/backends/ssh/unattended.rs"], { commentOnly });
    expect(on(flags)).toEqual(["rustdoc"]);
    expect(testMatrix(flags, true)).toEqual([]);
  });

  it("keeps the full Rust lane when any other Rust file has code changes", () => {
    const flags = classify(["core/src/backends/ssh/unattended.rs", "agent/src/main.rs"], {
      commentOnly,
    });
    expect(on(flags)).toEqual(["rust", "agent", "rustdoc"]);
  });

  it("combines with other areas as before", () => {
    const flags = classify(["core/src/backends/ssh/unattended.rs", "docs/a.md"], { commentOnly });
    expect(on(flags)).toEqual(["markdown", "rustdoc"]);
  });

  it("sets rustdoc for every Rust change, and all areas stay on for CI plumbing", () => {
    expect(classify(["src-tauri/src/lib.rs"]).rustdoc).toBe(true);
    expect(classify(["src/main.tsx"]).rustdoc).toBe(false);
    expect(allAreas().rustdoc).toBe(true);
  });

  it("only narrows workspace .rs sources", () => {
    expect(isNarrowableRustSource("core/src/lib.rs")).toBe(true);
    expect(isNarrowableRustSource("rdp-sidecar/src/main.rs")).toBe(false);
    expect(isNarrowableRustSource("Cargo.toml")).toBe(false);
    expect(isNarrowableRustSource(".github/x.rs")).toBe(false);
    // A comment-only claim for a non-narrowable path is ignored.
    const flags = classify(["rdp-sidecar/src/main.rs"], {
      commentOnly: new Set(["rdp-sidecar/src/main.rs"]),
    });
    expect(on(flags)).toEqual(["sidecar"]);
  });

  it("findCommentOnlyRust reads each file's diff and fails open on git errors", () => {
    const sources = {
      "B:core/src/a.rs": "/// old\nfn a() {}\n",
      "H:core/src/a.rs": "/// new\nfn a() {}\n",
      "B:core/src/b.rs": "fn b() { 1 }\n",
      "H:core/src/b.rs": "fn b() { 2 }\n",
    };
    const git = (args) => {
      if (args[0] === "diff") return "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n";
      const source = sources[args[1]];
      if (source === undefined) throw new Error("fatal: path does not exist");
      return source;
    };
    const found = findCommentOnlyRust(
      ["core/src/a.rs", "core/src/b.rs", "core/src/new.rs", "src/main.tsx"],
      "B",
      "H",
      git
    );
    expect([...found]).toEqual(["core/src/a.rs"]);
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
    expect(out).toContain("agent=false\n");
    expect(out).toContain("workflows=false\n");
    expect(out).toContain('test_matrix=["ubuntu-latest"]\n');
  });
});
