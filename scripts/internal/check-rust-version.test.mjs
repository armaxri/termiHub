import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  parsePinnedVersion,
  literalRustVersion,
  inheritsRustVersion,
  workspaceMembers,
  directToolchainUses,
  findProblems,
  loadRepo,
} from "./check-rust-version.mjs";

const ROOT_MANIFEST = [
  "[workspace]",
  "members = [",
  '    "core",',
  '    "vendor/vnc-rs",',
  '    # "commented-out",',
  "]",
  'resolver = "2"',
  "",
  "[workspace.package]",
  'rust-version = "1.98.0"',
  "",
  "[profile.dev]",
  "debug = 0",
].join("\n");

const MEMBER = '[package]\nname = "core"\nedition = "2021"\nrust-version.workspace = true\n';
const SIDECAR = '[package]\nname = "sidecar"\nrust-version = "1.98.0"\n\n[dependencies]\n';

/** A consistent repo view; tests override one field at a time. */
function repo(overrides = {}) {
  return {
    pinnedFile: "1.98.0\n",
    rootManifest: ROOT_MANIFEST,
    memberManifests: { core: MEMBER, "vendor/vnc-rs": '[package]\nname = "vnc-rs"\n' },
    standaloneManifests: { "rdp-sidecar": SIDECAR },
    workflows: { "ci.yml": "      - uses: ./.github/actions/setup-rust\n" },
    ...overrides,
  };
}

describe("parsePinnedVersion", () => {
  it("accepts an exact X.Y.Z version with surrounding whitespace", () => {
    expect(parsePinnedVersion("1.98.0\n")).toBe("1.98.0");
  });

  it("rejects channels, partial versions and missing files", () => {
    expect(parsePinnedVersion("stable")).toBeNull();
    expect(parsePinnedVersion("1.98")).toBeNull();
    expect(parsePinnedVersion(null)).toBeNull();
  });
});

describe("manifest helpers", () => {
  it("reads rust-version from the named table only", () => {
    expect(literalRustVersion(ROOT_MANIFEST, "workspace.package")).toBe("1.98.0");
    expect(literalRustVersion(ROOT_MANIFEST, "workspace")).toBeNull();
    expect(literalRustVersion(SIDECAR, "package")).toBe("1.98.0");
  });

  it("recognises both inheritance spellings", () => {
    expect(inheritsRustVersion(MEMBER)).toBe(true);
    expect(inheritsRustVersion("[package]\nrust-version = { workspace = true }\n")).toBe(true);
    expect(inheritsRustVersion('[package]\nrust-version = "1.98.0"\n')).toBe(false);
  });

  it("lists workspace members, ignoring comments", () => {
    expect(workspaceMembers(ROOT_MANIFEST)).toEqual(["core", "vendor/vnc-rs"]);
  });

  it("finds direct dtolnay/rust-toolchain uses in workflows", () => {
    const text = "steps:\n  - uses: dtolnay/rust-toolchain@abc # stable\n";
    expect(directToolchainUses({ "a.yml": text })).toEqual(["a.yml:2"]);
  });
});

describe("findProblems", () => {
  it("passes a consistent repo", () => {
    expect(findProblems(repo())).toEqual([]);
  });

  it("fails on a malformed pin file", () => {
    expect(findProblems(repo({ pinnedFile: "stable" }))).toHaveLength(1);
  });

  it("fails when the workspace rust-version drifts from the pin", () => {
    const problems = findProblems(repo({ pinnedFile: "1.99.0" }));
    expect(problems.some((p) => p.includes("[workspace.package]"))).toBe(true);
    expect(problems.some((p) => p.startsWith("rdp-sidecar"))).toBe(true);
  });

  it("fails when a first-party member does not inherit, but ignores vendor/", () => {
    const problems = findProblems(
      repo({ memberManifests: { core: '[package]\nname = "core"\n', "vendor/x": "" } })
    );
    expect(problems).toEqual([
      "core/Cargo.toml [package] must set `rust-version.workspace = true`",
    ]);
  });

  it("fails when the sidecar declares no rust-version", () => {
    const problems = findProblems(
      repo({ standaloneManifests: { "rdp-sidecar": '[package]\nname = "s"\n' } })
    );
    expect(problems).toHaveLength(1);
  });

  it("fails when a workflow installs a toolchain directly", () => {
    const problems = findProblems(
      repo({ workflows: { "x.yml": "      - uses: dtolnay/rust-toolchain@1.97.0\n" } })
    );
    expect(problems).toHaveLength(1);
  });
});

describe("the real repository", () => {
  it("is consistent", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(findProblems(loadRepo(root))).toEqual([]);
  });
});
