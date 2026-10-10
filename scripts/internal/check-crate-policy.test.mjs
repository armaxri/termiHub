import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  tableValue,
  hasNoPanicHeader,
  binPaths,
  policyCrates,
  findProblems,
  loadRepo,
  runnerFeatureLeaks,
} from "./check-crate-policy.mjs";

const ROOT_MANIFEST = [
  "[workspace]",
  "members = [",
  '    "core",',
  '    "vendor/vnc-rs",',
  '    "examples/plugins/echo",',
  '    "tests/probe",',
  "]",
  "",
  "[profile.release]",
  "overflow-checks = true",
  "# Keep the symbol table (#4316).",
  'strip = "debuginfo"',
].join("\n");

const SIDECAR = [
  "[package]",
  'name = "sidecar"',
  "",
  "[profile.release]",
  "overflow-checks = true",
  'strip = "debuginfo" # mirrored',
  "",
  "[[bin]]",
  'name = "helper"',
  'path = "src/main.rs"',
].join("\n");

const HEADER = [
  "//! Crate docs.",
  "#![cfg_attr(",
  "    not(test),",
  "    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)",
  ")]",
  "",
  "fn main() {}",
].join("\n");

/** A compliant repo view; tests override one field at a time. */
function repo(overrides = {}) {
  return {
    rootManifest: ROOT_MANIFEST,
    standaloneManifests: { "rdp-sidecar": SIDECAR },
    crateRoots: {
      core: { "src/lib.rs": HEADER, "src/bin/tool.rs": HEADER },
      "rdp-sidecar": { "src/main.rs": HEADER },
    },
    ...overrides,
  };
}

describe("tableValue", () => {
  it("reads a raw value from the named table, ignoring trailing comments", () => {
    expect(tableValue(ROOT_MANIFEST, "profile.release", "overflow-checks")).toBe("true");
    expect(tableValue(SIDECAR, "profile.release", "strip")).toBe('"debuginfo"');
    expect(tableValue(SIDECAR, "package", "strip")).toBeNull();
    expect(tableValue("[package]\n", "profile.release", "strip")).toBeNull();
  });
});

describe("hasNoPanicHeader", () => {
  it("accepts the multi-line header", () => {
    expect(hasNoPanicHeader(HEADER)).toBe(true);
  });

  it("accepts a one-line header with the lints in any order", () => {
    const src =
      "#![cfg_attr(not(test), deny(clippy::panic, clippy::unwrap_used, clippy::expect_used))]";
    expect(hasNoPanicHeader(src)).toBe(true);
  });

  it("rejects a header missing one lint", () => {
    const src = "#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]";
    expect(hasNoPanicHeader(src)).toBe(false);
  });

  it("rejects a commented-out header and a missing one", () => {
    const src =
      "// #![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]";
    expect(hasNoPanicHeader(src)).toBe(false);
    expect(hasNoPanicHeader("fn main() {}\n")).toBe(false);
  });

  it("rejects an outer attribute (it would not apply to the crate)", () => {
    const src =
      "#[cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]";
    expect(hasNoPanicHeader(src)).toBe(false);
  });
});

describe("binPaths / policyCrates", () => {
  it("lists every [[bin]] path", () => {
    const toml = `${SIDECAR}\n\n[[bin]]\nname = "b"\npath = "src/bin/b.rs"\n\n[dependencies]\n`;
    expect(binPaths(toml)).toEqual(["src/main.rs", "src/bin/b.rs"]);
  });

  it("covers first-party members plus the excluded crates, not vendor/examples/tests", () => {
    expect(policyCrates(ROOT_MANIFEST)).toEqual(["core", "rdp-sidecar"]);
  });
});

describe("findProblems", () => {
  it("passes a compliant repo", () => {
    expect(findProblems(repo())).toEqual([]);
  });

  it("fails when the root release profile drops overflow-checks", () => {
    const rootManifest = ROOT_MANIFEST.replace("overflow-checks = true", "overflow-checks = false");
    const problems = findProblems(repo({ rootManifest }));
    expect(problems.some((p) => p.startsWith("Cargo.toml [profile.release]"))).toBe(true);
  });

  it("fails when the sidecar release profile omits overflow-checks (PKG2-008)", () => {
    const sidecar = SIDECAR.replace("overflow-checks = true\n", "");
    const problems = findProblems(repo({ standaloneManifests: { "rdp-sidecar": sidecar } }));
    expect(problems).toEqual([
      'rdp-sidecar/Cargo.toml [profile.release] overflow-checks is null, expected "true" ' +
        "(the root profile does not apply to a workspace-excluded crate)",
    ]);
  });

  it("fails when the sidecar strip setting drifts from the root", () => {
    const sidecar = SIDECAR.replace('strip = "debuginfo"', "strip = true");
    const problems = findProblems(repo({ standaloneManifests: { "rdp-sidecar": sidecar } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("strip");
  });

  it("fails when a crate root lacks the no-panic header (TOOL2-002)", () => {
    const problems = findProblems(
      repo({
        crateRoots: {
          core: { "src/lib.rs": HEADER, "src/bin/tool.rs": "fn main() {}\n" },
          "rdp-sidecar": { "src/main.rs": HEADER },
        },
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^core\/src\/bin\/tool\.rs: missing the TOOL-010 header/);
  });

  it("fails on a missing manifest, a missing bin path and a crate with no root", () => {
    const problems = findProblems(
      repo({
        standaloneManifests: { "rdp-sidecar": null },
        crateRoots: { core: { "src/bin/gone.rs": null }, "plugin-runner": {}, x: null },
      })
    );
    expect(problems).toEqual([
      "rdp-sidecar/Cargo.toml not found",
      "core/src/bin/gone.rs: [[bin]] path does not exist",
      "plugin-runner: no crate root found (src/lib.rs, src/main.rs or a [[bin]] path)",
      "x/Cargo.toml not found",
    ]);
  });
});

describe("runnerFeatureLeaks (ADR-19, #4373)", () => {
  const CORE = [
    "[dependencies]",
    'termihub-plugin-runner = { path = "../plugin-runner", optional = true, default-features = false }',
    "",
    "[dev-dependencies]",
    "# Test-only: the in-process loader baseline.",
    'termihub-plugin-runner = { path = "../plugin-runner", features = ["runner"] }',
    "",
    "[features]",
    'plugin = ["dep:termihub-plugin-runner"]',
  ].join("\n");

  it("accepts the runner library without its runner feature, and a runner dev-dependency", () => {
    expect(runnerFeatureLeaks(CORE)).toEqual([]);
  });

  it("rejects a normal dependency that keeps the default features", () => {
    const toml = CORE.replace(", default-features = false", "");
    expect(runnerFeatureLeaks(toml)).toEqual([
      "[dependencies] termihub-plugin-runner: a normal dependency on termihub-plugin-runner must " +
        "set `default-features = false` (its default `runner` feature is runner-only, ADR-19)",
    ]);
  });

  it("rejects a bare version requirement (it keeps the default features)", () => {
    expect(runnerFeatureLeaks('[dependencies]\ntermihub-plugin-runner = "0.1"\n')).toHaveLength(1);
  });

  it("rejects enabling runner explicitly, in a target table or through a rename", () => {
    const explicit = CORE.replace(
      "default-features = false }",
      'default-features = false, features = ["runner"] }'
    );
    expect(runnerFeatureLeaks(explicit)).toEqual([
      "[dependencies] termihub-plugin-runner: a normal dependency on termihub-plugin-runner must " +
        "not enable `runner` (ADR-19)",
    ]);
    const target = "[target.'cfg(unix)'.dependencies]\ntermihub-plugin-runner = { path = \"x\" }\n";
    expect(runnerFeatureLeaks(target)).toHaveLength(1);
    const renamed = '[dependencies]\nrunner = { package = "termihub-plugin-runner", path = "x" }\n';
    expect(runnerFeatureLeaks(renamed)).toHaveLength(1);
  });

  it("rejects a dotted dependency table and a feature forwarding runner", () => {
    const dotted = [
      "[dependencies.termihub-plugin-runner]",
      'path = "../plugin-runner"',
      'features = ["runner"]',
      "default-features = false",
      "",
      "[features]",
      'plugin = ["termihub-plugin-runner?/runner"]',
    ].join("\n");
    expect(runnerFeatureLeaks(dotted)).toEqual([
      "[dependencies.termihub-plugin-runner]: a normal dependency on termihub-plugin-runner " +
        "must not enable `runner` (ADR-19)",
      "[features]: must not enable termihub-plugin-runner/runner (ADR-19)",
    ]);
  });

  it("is reported per crate by findProblems", () => {
    const problems = findProblems(
      repo({ memberManifests: { core: CORE.replace(", default-features = false", "") } })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^core\/Cargo\.toml \[dependencies\] termihub-plugin-runner:/);
  });
});

describe("the real repository", () => {
  it("is compliant", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const loaded = loadRepo(root);
    expect(findProblems(loaded)).toEqual([]);
    // The crates #4343 brought under the policy are actually scanned.
    expect(Object.keys(loaded.crateRoots)).toEqual(
      expect.arrayContaining(["plugin-runner", "rdp-sidecar", "win-security"])
    );
    expect(Object.keys(loaded.crateRoots["plugin-runner"])).toEqual(["src/lib.rs", "src/main.rs"]);
    // Rule 4 scans the desktop and core, but never the runner itself (#4373).
    expect(Object.keys(loaded.memberManifests)).toEqual(
      expect.arrayContaining(["core", "src-tauri"])
    );
    expect(loaded.memberManifests).not.toHaveProperty("plugin-runner");
  });
});
