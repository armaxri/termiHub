import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_FILES,
  AGENT_ROOTS,
  classify,
  allAreas,
  testMatrix,
  formatOutputs,
  findCommentOnlyRust,
  isNarrowableRustSource,
  hasSkipTestsTag,
  skipTestsRequested,
  skipTestsNote,
  skipTestsBlockers,
  resolveSkipTests,
  skipTestsIgnoredNote,
  SKIP_TESTS_TAG,
} from "./ci-changes.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "ci-changes.mjs");
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "..", "..");

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
    expect(on(classify(["core/src/lib.rs"]))).toEqual(["rust", "sidecar", "agent", "rustdoc"]);
    expect(on(classify(["agent/tests/local_agent_integration.rs"]))).toEqual([
      "rust",
      "agent",
      "rustdoc",
    ]);
    expect(on(classify(["vendor/vnc-rs/src/lib.rs"]))).toEqual(["rust", "agent", "rustdoc"]);
    expect(classify(["plugin-api/src/lib.rs"])).toMatchObject({ rust: true, agent: true });
    expect(classify(["plugin-runner/src/lib.rs"])).toMatchObject({ rust: true, agent: true });
    expect(classify(["win-security/src/lib.rs"])).toMatchObject({ rust: true, agent: true });
    expect(classify(["rust-toolchain.toml"])).toMatchObject({ rust: true, agent: true });
    expect(classify(["Cargo.lock"])).toMatchObject({ rust: true, deps: true, agent: true });
  });

  it("flags plugin_fuzz for anything the plugin-runner fuzz crate builds from (#4257)", () => {
    const fuzz = ["rust", "agent", "rustdoc", "plugin_fuzz"];
    expect(on(classify(["plugin-runner/src/ipc/messages.rs"]))).toEqual(fuzz);
    expect(on(classify(["plugin-runner/fuzz/src/lib.rs"]))).toEqual(fuzz);
    expect(on(classify(["plugin-runner/fuzz/fuzz_targets/host_decode.rs"]))).toEqual(fuzz);
    expect(classify(["plugin-runner/Cargo.toml"])).toMatchObject({ deps: true, plugin_fuzz: true });
    expect(on(classify(["plugin-api/src/lib.rs"]))).toEqual(fuzz);
    // win-security also feeds the RDP sidecar through core (#4357).
    expect(on(classify(["win-security/src/windows.rs"]))).toEqual([
      "rust",
      "sidecar",
      "agent",
      "rustdoc",
      "plugin_fuzz",
    ]);
    expect(on(classify(["rust-toolchain.toml"]))).toEqual([
      "rust",
      "sidecar",
      "agent",
      "rustdoc",
      "plugin_fuzz",
    ]);
    expect(on(classify([".cargo/config.toml"]))).toEqual(fuzz);
    expect(classify(["Cargo.toml"])).toMatchObject({ rust: true, plugin_fuzz: true });
  });

  it("does not flag plugin_fuzz for Rust the fuzz crate does not build from", () => {
    expect(classify(["core/src/lib.rs"]).plugin_fuzz).toBe(false);
    expect(classify(["agent/src/main.rs"]).plugin_fuzz).toBe(false);
    expect(classify(["src-tauri/src/lib.rs"]).plugin_fuzz).toBe(false);
    expect(classify(["core/Cargo.toml"]).plugin_fuzz).toBe(false);
    // The fuzz crate keeps its own lockfile; the workspace one does not feed it.
    expect(classify(["Cargo.lock"]).plugin_fuzz).toBe(false);
    expect(classify(["src/main.tsx"]).plugin_fuzz).toBe(false);
  });

  it("narrows a comment-only plugin-runner change off the fuzz check", () => {
    const path = "plugin-runner/src/ipc/messages.rs";
    expect(on(classify([path], { commentOnly: new Set([path]) }))).toEqual(["rustdoc"]);
  });

  it("does not flag agent for Rust the agent does not build from", () => {
    expect(classify(["src-tauri/src/lib.rs"]).agent).toBe(false);
    expect(classify(["examples/plugin/src/lib.rs"]).agent).toBe(false);
    expect(classify(["core/Cargo.toml"]).agent).toBe(true);
  });

  it("runs the Rust and agent test legs when the Rust test driver changes", () => {
    expect(on(classify(["scripts/internal/ci-rust-tests.sh"]))).toEqual([
      "rust",
      "frontend",
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

  it("runs the frontend suite for capability changes — the capability guard is vitest (#3115)", () => {
    expect(on(classify(["src-tauri/capabilities/default.json"]))).toEqual([
      "rust",
      "frontend",
      "rustdoc",
    ]);
  });

  it("runs the script smoke (real ConPTY fetch) when the ConPTY pins change (#4121)", () => {
    expect(classify(["src-tauri/packaging/windows/conpty.env"])).toMatchObject({
      rust: true,
      scripts: true,
    });
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

  // #4357 (SUP2-004): rdp-sidecar depends on termihub-core by path, core pulls
  // win-security by path and inherits versions from the root Cargo.toml, so a
  // change there alters the shipped sidecar graph and must run its cargo-deny gate.
  it("runs the sidecar job for what the sidecar compiles from outside rdp-sidecar/", () => {
    expect(classify(["core/src/lib.rs"]).sidecar).toBe(true);
    expect(classify(["core/Cargo.toml"])).toMatchObject({ sidecar: true, deps: true });
    expect(classify(["win-security/src/lib.rs"]).sidecar).toBe(true);
    expect(classify(["Cargo.toml"])).toMatchObject({ rust: true, sidecar: true });
    expect(classify(["rust-toolchain.toml"]).sidecar).toBe(true);
  });

  it("does not run the sidecar job for Rust the sidecar does not build from", () => {
    // The sidecar resolves against its own lockfile, not the workspace one.
    expect(classify(["Cargo.lock"]).sidecar).toBe(false);
    expect(classify(["agent/src/main.rs"]).sidecar).toBe(false);
    expect(classify(["src-tauri/src/lib.rs"]).sidecar).toBe(false);
    expect(classify(["plugin-runner/src/lib.rs"]).sidecar).toBe(false);
    expect(classify(["src/main.tsx"]).sidecar).toBe(false);
  });

  it("narrows a comment-only core change off the sidecar job", () => {
    const path = "core/src/lib.rs";
    expect(on(classify([path], { commentOnly: new Set([path]) }))).toEqual(["rustdoc"]);
  });

  it("maps ts-rs generated types to both rust and frontend", () => {
    expect(classify(["src/types/generated/Foo.ts"])).toMatchObject({ rust: true, frontend: true });
  });

  it("routes scripts by kind", () => {
    expect(on(classify(["scripts/dev.sh"]))).toEqual(["frontend", "scripts"]);
    expect(on(classify(["scripts/hooks/pre-push"]))).toEqual(["frontend", "scripts"]);
    expect(on(classify(["scripts/internal/parse-issue-refs.mjs"]))).toEqual(["frontend"]);
    expect(on(classify(["scripts/internal/ci-changes.mjs"]))).toEqual(["frontend"]);
    expect(on(classify(["scripts/check-testid-drift.py"]))).toEqual(["frontend", "harness"]);
    expect(classify(["scripts/package-plugin.sh"])).toMatchObject({ rust: true, scripts: true });
  });

  // #3942: the scripts/internal vitest suite (run by the `frontend` area) reads
  // files across scripts/**, e.g. regen-testid-catalog.test.mjs pins the hook's
  // trigger list to scripts/build-testid-catalog.py. #3935 changed only that .py,
  // skipped vitest, and turned develop red after merge.
  it("runs the scripts/internal vitest suite for a PR touching only a pinned Python script", () => {
    const flags = classify(["scripts/build-testid-catalog.py"]);
    expect(flags).toMatchObject({ frontend: true, harness: true });
    expect(testMatrix(flags, true)).toEqual(["ubuntu-latest"]);
  });

  it("runs the scripts/internal vitest suite for every file under scripts/", () => {
    for (const path of [
      "scripts/build-testid-catalog.py",
      "scripts/coverage-baseline.json",
      "scripts/release-marker-allowlist.json",
      "scripts/README.md",
      "scripts/package-plugin.sh",
      "scripts/pnpm-audit-prod-gate.sh",
      "scripts/internal/ci-rust-tests.sh",
      "scripts/hooks/pre-push",
    ]) {
      expect(classify([path]).frontend, path).toBe(true);
    }
  });

  it("adds scripts for any shell script, wherever it lives", () => {
    expect(classify(["agent/docker/entrypoint.sh"])).toMatchObject({ rust: true, scripts: true });
    expect(on(classify(["tests/docker/ssh/setup.sh"]))).toEqual(["scripts", "harness"]);
  });

  it("maps the Python harness to harness", () => {
    expect(on(classify(["tests/system/tests/test_x.py"]))).toEqual(["harness"]);
  });

  it("runs the harness contract test when the in-app test bridge changes", () => {
    expect(on(classify(["src/testbridge/protocol.ts"]))).toEqual(["frontend", "harness"]);
  });

  it("runs the machinery suite for files its isolation tests read (#4358, TIN2-003)", () => {
    // test_dev_local.py parses the compose files and the shell resolver; a PR
    // touching only these used to skip the machinery job and merge untested.
    expect(on(classify(["tests/docker/docker-compose.yml"]))).toEqual(["scripts", "harness"]);
    expect(on(classify(["scripts/internal/dev-local-env.sh"]))).toEqual([
      "frontend",
      "scripts",
      "harness",
    ]);
    expect(classify(["examples/docker/docker-compose.yml"])).toMatchObject({ harness: true });
    expect(classify(["examples/dev3.dev.local.json"])).toMatchObject({ harness: true });
    for (const fixture of ["sh", "ps1"]) {
      expect(classify([`scripts/internal/native-sshd-fixture.${fixture}`])).toMatchObject({
        harness: true,
        scripts: true,
      });
    }
    expect(classify(["scripts/test.sh"])).toMatchObject({ harness: true });
    expect(classify(["scripts/test-system-py.sh"])).toMatchObject({ harness: true });
    expect(classify(["scripts/internal/build-system-test-agent.sh"])).toMatchObject({
      harness: true,
    });
    // Unrelated scripts and examples stay off the harness lane.
    expect(classify(["scripts/dev.sh"]).harness).toBe(false);
    expect(classify(["examples/plugins/clock-widget/src/lib.rs"]).harness).toBe(false);
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

describe("agent.yml path filter (#4358, CI2-008)", () => {
  // No YAML parser is a direct dependency, so read the two `paths:` lists
  // line-wise: `  <event>:` at indent 2, then `    paths:`, then `      - '…'`
  // items (comments skipped) until the first other line.
  const text = readFileSync(path.join(REPO_ROOT, ".github/workflows/agent.yml"), "utf8");
  const pathsOf = (event) => {
    const lines = text.split("\n");
    let at = lines.indexOf(`  ${event}:`);
    if (at < 0) throw new Error(`agent.yml has no ${event} trigger`);
    while (at < lines.length && !/^ {4}paths:\s*$/.test(lines[at])) at += 1;
    const found = [];
    for (at += 1; at < lines.length; at += 1) {
      if (/^\s*#/.test(lines[at])) continue;
      const item = /^ {6}- '([^']+)'\s*$/.exec(lines[at]);
      if (!item) break;
      found.push(item[1]);
    }
    if (found.length === 0) throw new Error(`agent.yml ${event} has no paths filter`);
    return found;
  };
  const triggers = {
    pull_request: { paths: pathsOf("pull_request") },
    push: { paths: pathsOf("push") },
  };
  const toolchain = ["rust-toolchain*", ".github/rust-version", ".github/actions/setup-rust/**"];

  it.each(["pull_request", "push"])("%s paths cover every agent input", (event) => {
    const paths = triggers[event].paths;
    for (const root of AGENT_ROOTS) expect(paths).toContain(`${root}**`);
    for (const file of AGENT_FILES) expect(paths).toContain(file);
    for (const entry of toolchain) expect(paths).toContain(entry);
  });

  it("uses the same paths for pull_request and push", () => {
    expect([...triggers.push.paths].sort()).toEqual([...triggers.pull_request.paths].sort());
  });

  it("classifies every agent.yml path pattern as an agent input", () => {
    // The converse direction: nothing in the filter that the job gate would
    // then skip, except the workflow's own plumbing and scripts it runs.
    const own = /^(\.github\/|scripts\/|tests\/release-crash-probe\/)/;
    for (const pattern of triggers.pull_request.paths) {
      if (own.test(pattern)) continue;
      const sample = pattern.replace(/\*\*$/, "x.rs").replace(/\*$/, ".toml");
      expect(classify([sample]).agent, pattern).toBe(true);
    }
  });
});

describe("live lane path filters (#4618)", () => {
  // Per-platform live lanes (Windows SSH host, WSL) run only on PRs whose
  // files match a hand-written `pull_request.paths` list, not ci-changes.mjs.
  // A source file the suite exercises but the list omits means a PR changing
  // it skips the lane (#4609 changed core/src/backends/ssh/remote_shell.rs and
  // the Windows SSH host lane never ran). Each lane declares here the sources
  // its suite exercises; the workflow must list every one of them verbatim.
  // When a suite starts exercising a new area, add it here and to the
  // workflow.
  const LANES = {
    "windows-ssh-host.yml": [
      // Desktop -> Windows host (windows_ssh_host_tests.rs).
      "src-tauri/src/terminal/agent_deploy.rs",
      "src-tauri/src/terminal/agent_install.rs",
      "src-tauri/src/terminal/agent_binary.rs",
      "src-tauri/src/terminal/backend.rs",
      "src-tauri/src/terminal/jsonrpc.rs",
      "src-tauri/src/terminal/agent_manager/**",
      "src-tauri/src/utils/remote_exec.rs",
      "src-tauri/src/utils/ssh_auth.rs",
      // The core SSH backend, incl. the shell-integration setup (#4143) and
      // the initial-command / OSC 7 setup it takes from session/shell.rs.
      "core/src/backends/ssh/**",
      "core/src/session/shell.rs",
      // Windows agent -> targets (native_sshd_agent_backends.rs).
      "core/src/backends/docker/list.rs",
      "core/src/backends/docker/runtime.rs",
      "agent/src/daemon/**",
      "agent/src/session/**",
      "agent/tests/native_sshd_agent_backends.rs",
      "agent/tests/common/**",
      // The recipe and fixture.
      "scripts/internal/run-windows-ssh-host-suite.sh",
      "scripts/internal/native-sshd-fixture.*",
      ".github/workflows/windows-ssh-host.yml",
    ],
    "wsl-live.yml": [
      "core/src/backends/wsl.rs",
      "core/src/backends/wsl_*.rs",
      "core/src/backends/conpty_cursor.rs",
      "core/src/session/shell.rs",
      "core/src/files/browser.rs",
      "core/src/files/copy.rs",
      "core/src/files/local.rs",
      "core/src/files/ranged.rs",
      "core/src/files/utils.rs",
      "core/src/files/transfer/attempt.rs",
      "core/src/files/transfer/local.rs",
      "core/src/files/transfer/local_folder.rs",
      "core/src/files/transfer/mod.rs",
      "core/src/files/transfer/progress.rs",
      "core/src/files/transfer/registry.rs",
      "core/src/files/transfer/retry.rs",
      "core/src/files/transfer/scheduler.rs",
      "core/src/files/transfer/state.rs",
      ".github/workflows/wsl-live.yml",
    ],
  };

  // Read `pull_request:` -> `paths:` line-wise (no YAML parser dependency),
  // accepting single- or double-quoted items and skipping comment lines.
  const pullRequestPaths = (workflow) => {
    const lines = readFileSync(path.join(REPO_ROOT, ".github/workflows", workflow), "utf8").split(
      "\n"
    );
    let at = lines.indexOf("  pull_request:");
    if (at < 0) throw new Error(`${workflow} has no pull_request trigger`);
    for (at += 1; at < lines.length && !/^ {4}paths:\s*$/.test(lines[at]); at += 1) {
      if (/^ {0,2}\S/.test(lines[at])) throw new Error(`${workflow} pull_request has no paths`);
    }
    const found = [];
    for (at += 1; at < lines.length; at += 1) {
      if (/^\s*#/.test(lines[at])) continue;
      const item = /^ {6}- (["'])([^"']+)\1\s*$/.exec(lines[at]);
      if (!item) break;
      found.push(item[2]);
    }
    return found;
  };

  // Minimal glob -> RegExp for the patterns these filters use: `**` spans
  // directories, `*` stays within one path segment.
  const globRegExp = (glob) =>
    new RegExp(
      "^" +
        glob
          .split("**")
          .map((part) =>
            part
              .split("*")
              .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
              .join("[^/]*")
          )
          .join(".*") +
        "$"
    );
  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  describe.each(Object.entries(LANES))("%s", (workflow, required) => {
    const paths = pullRequestPaths(workflow);

    it("lists every source area its suite exercises", () => {
      const missing = required.filter((glob) => !paths.includes(glob));
      expect(missing, `add these to ${workflow} pull_request.paths`).toEqual([]);
    });

    it("lists no path that matches nothing (a renamed or deleted file)", () => {
      const stale = paths.filter((glob) => !tracked.some((f) => globRegExp(glob).test(f)));
      expect(stale, `${workflow} pull_request.paths entries matching no file`).toEqual([]);
    });
  });

  it("matches globs the way the path filters do", () => {
    expect(globRegExp("core/src/backends/ssh/**").test("core/src/backends/ssh/a/b.rs")).toBe(true);
    expect(globRegExp("core/src/backends/wsl_*.rs").test("core/src/backends/wsl_exec.rs")).toBe(
      true
    );
    expect(globRegExp("core/src/backends/wsl_*.rs").test("core/src/backends/wsl/x.rs")).toBe(false);
    expect(globRegExp("core/src/files/local.rs").test("core/src/files/localXrs")).toBe(false);
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

  it("reports tests=true by default and keeps the matrix", () => {
    const out = formatOutputs(classify(["core/src/lib.rs"]), true);
    expect(out).toContain("tests=true\n");
    expect(out).toContain('test_matrix=["ubuntu-latest","windows-latest"]\n');
  });

  it("under [skip-tests] reports tests=false and an empty matrix, areas unchanged", () => {
    const out = formatOutputs(classify(["core/src/lib.rs"]), true, { skipTests: true });
    expect(out).toContain("tests=false\n");
    expect(out).toContain("test_matrix=[]\n");
    // Quality/lint/rustdoc jobs still see their areas.
    expect(out).toContain("rust=true\n");
    expect(out).toContain("rustdoc=true\n");
  });
});

describe("[skip-tests] tag (#3915)", () => {
  // A fake git that answers `log -1 --format=%B <sha> --` from a sha->message map.
  const fakeGit = (messages) => (args) => {
    expect(args.slice(0, 3)).toEqual(["log", "-1", "--format=%B"]);
    const sha = args[3];
    if (!(sha in messages)) throw new Error(`unknown revision ${sha}`);
    return messages[sha];
  };
  const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const OLDER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("matches the exact tag anywhere in the message", () => {
    expect(hasSkipTestsTag("docs: fix typo [skip-tests]")).toBe(true);
    expect(hasSkipTestsTag("style: reflow\n\n[skip-tests]\n")).toBe(true);
    expect(hasSkipTestsTag("docs: fix typo")).toBe(false);
    expect(hasSkipTestsTag("docs: [skip tests] [skip-test]")).toBe(false);
    expect(hasSkipTestsTag(undefined)).toBe(false);
    expect(SKIP_TESTS_TAG).toBe("[skip-tests]");
  });

  it("skips when the PR head commit carries the tag", () => {
    const git = fakeGit({ [HEAD]: "docs: reword comment [skip-tests]\n", [OLDER]: "feat: x\n" });
    expect(skipTestsRequested({ eventName: "pull_request", headSha: HEAD, git })).toBe(true);
  });

  it("does not skip when only an older commit carries the tag", () => {
    const git = fakeGit({ [HEAD]: "fix: real change\n", [OLDER]: "docs: typo [skip-tests]\n" });
    expect(skipTestsRequested({ eventName: "pull_request", headSha: HEAD, git })).toBe(false);
  });

  it("ignores the tag on push, schedule and dispatch events", () => {
    const git = fakeGit({ [HEAD]: "docs: typo [skip-tests]\n" });
    for (const eventName of ["push", "schedule", "workflow_dispatch", "workflow_call", undefined]) {
      expect(skipTestsRequested({ eventName, headSha: HEAD, git })).toBe(false);
    }
  });

  it("fails open (runs tests) without a head sha, on an unsafe rev, or on a git error", () => {
    const git = fakeGit({ [HEAD]: "docs: typo [skip-tests]\n" });
    expect(skipTestsRequested({ eventName: "pull_request", headSha: "", git })).toBe(false);
    expect(skipTestsRequested({ eventName: "pull_request", headSha: "--output=x", git })).toBe(
      false
    );
    expect(skipTestsRequested({ eventName: "pull_request", headSha: OLDER, git })).toBe(false);
  });

  it("is ignored when the PR changes CI itself (.github or detection/gate scripts)", () => {
    const git = fakeGit({ [HEAD]: "style: reflow [skip-tests]\n" });
    const blocking = [
      ".github/workflows/code-quality.yml",
      ".github/actions/detect-changes/action.yml",
      "scripts/internal/ci-changes.mjs",
      "scripts/internal/ci-changes.test.mjs",
      "scripts/internal/rust-comment-diff.mjs",
      "scripts/internal/rust-comment-diff.test.mjs",
      "scripts/internal/ci-rust-tests.sh",
      "scripts/internal/pr-gate.mjs",
      "scripts/internal/pr-gate.test.mjs",
    ];
    for (const path of blocking) {
      const paths = ["core/src/lib.rs", path];
      expect(skipTestsBlockers(paths)).toEqual([path]);
      expect(resolveSkipTests({ eventName: "pull_request", headSha: HEAD, paths, git })).toEqual({
        skip: false,
        requested: true,
        blockedBy: [path],
      });
    }
    // Other scripts/internal helpers and ordinary code do not block it.
    const paths = ["core/src/lib.rs", "scripts/internal/bundle-size.mjs", "docs/a.md"];
    expect(skipTestsBlockers(paths)).toEqual([]);
    expect(resolveSkipTests({ eventName: "pull_request", headSha: HEAD, paths, git }).skip).toBe(
      true
    );
    expect(skipTestsIgnoredNote([".github/x.yml"])).toBe(
      "[skip-tests] ignored: this PR changes CI (.github/x.yml); running every lane"
    );
  });

  it("names the sha in the job-summary note", () => {
    expect(skipTestsNote(HEAD)).toBe(`tests skipped by [skip-tests] on ${HEAD}`);
  });

  // End to end against a real git repo shaped like a pull_request checkout: HEAD
  // is the synthetic merge commit, HEAD^1 the base tip, HEAD^2 the PR head.
  describe("CLI against a simulated PR merge commit", () => {
    const git = (cwd, ...args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      }).trim();

    /** Build base -> PR commits (messages in order) -> merge commit; returns the dir. */
    const makePr = (messages) => {
      const dir = mkdtempSync(path.join(tmpdir(), "ci-changes-skip-"));
      git(dir, "init", "-q", "-b", "develop");
      git(dir, "config", "commit.gpgsign", "false");
      writeFileSync(path.join(dir, "base.txt"), "base\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "--no-verify", "-m", "chore: base");
      git(dir, "checkout", "-q", "-b", "pr");
      messages.forEach((message, i) => {
        writeFileSync(path.join(dir, `f${i}.rs`), `// ${i}\n`);
        git(dir, "add", ".");
        git(dir, "commit", "-q", "--no-verify", "-m", message);
      });
      git(dir, "checkout", "-q", "develop");
      writeFileSync(path.join(dir, "develop.txt"), "moved on\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "--no-verify", "-m", "chore: develop advanced");
      // Even a tagged merge-commit message must not count: only the PR head does.
      git(dir, "merge", "-q", "--no-ff", "--no-verify", "-m", "Merge pr [skip-tests]", "pr");
      return dir;
    };

    const run = (dir, args) => {
      const summary = path.join(dir, "summary.md");
      writeFileSync(summary, "");
      const res = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: dir,
        input: "core/src/lib.rs\n",
        encoding: "utf8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
      });
      expect(res.status).toBe(0);
      return { out: res.stdout, summary: readFileSync(summary, "utf8"), stderr: res.stderr };
    };

    it("skips when the PR head (HEAD^2 / head.sha) is tagged, and says so", () => {
      const dir = makePr(["feat: real change", "docs: reword comment [skip-tests]"]);
      try {
        const headSha = git(dir, "rev-parse", "HEAD^2");
        for (const rev of [headSha, "HEAD^2"]) {
          const { out, summary } = run(dir, ["--event", "pull_request", "--head-sha", rev]);
          expect(out).toContain("tests=false\n");
          expect(out).toContain("test_matrix=[]\n");
          expect(out).toContain("rust=true\n");
          expect(summary).toContain(`tests skipped by [skip-tests] on ${rev}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("runs everything when only an older PR commit is tagged", () => {
      const dir = makePr(["docs: reword comment [skip-tests]", "fix: real change"]);
      try {
        const headSha = git(dir, "rev-parse", "HEAD^2");
        const { out, summary } = run(dir, ["--event", "pull_request", "--head-sha", headSha]);
        expect(out).toContain("tests=true\n");
        expect(out).toContain('test_matrix=["ubuntu-latest","windows-latest"]\n');
        expect(summary).toBe("");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("ignores the tag, with a notice, when the PR changes CI", () => {
      const dir = makePr(["style: reflow [skip-tests]"]);
      try {
        const summary = path.join(dir, "summary.md");
        writeFileSync(summary, "");
        const res = spawnSync(
          process.execPath,
          [SCRIPT, "--event", "pull_request", "--head-sha", "HEAD^2"],
          {
            cwd: dir,
            input: "core/src/lib.rs\n.github/workflows/build.yml\n",
            encoding: "utf8",
            env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
          }
        );
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("tests=true\n");
        expect(res.stderr).toContain("[skip-tests] ignored: this PR changes CI");
        expect(readFileSync(summary, "utf8")).toContain("[skip-tests] ignored");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("ignores the tag on a push event and never reads the merge commit", () => {
      const dir = makePr(["docs: reword comment [skip-tests]"]);
      try {
        const headSha = git(dir, "rev-parse", "HEAD^2");
        expect(run(dir, ["--event", "push", "--head-sha", headSha]).out).toContain("tests=true\n");
        // HEAD is the merge commit; its own "[skip-tests]" is irrelevant — the
        // action always passes the PR head, and --all (non-PR events) never skips.
        expect(run(dir, ["--all"]).out).toContain("tests=true\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
