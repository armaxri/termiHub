import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  cargoPackage,
  lockedVersions,
  isValidLine,
  onLine,
  watchlistRows,
  findProblems,
  loadRepo,
} from "./check-vendored-forks.mjs";

const SHA = "f8ac0ee4915e8e1e1adb8880a0716761b91281f6";

const FORK = {
  path: "vendor/vnc-rs",
  crate: "vnc-rs",
  upstream_repo: "https://github.com/HsuJv/vnc-rs",
  upstream_branch: "main",
  upstream_path: "",
  base_version: "0.5.3",
  base_commit: SHA,
  reviewed_version: "0.5.3",
  reviewed_commit: SHA,
  deltas: [{ summary: "VeNCrypt", refs: ["https://github.com/armaxri/termiHub/issues/1714"] }],
  watch: { crates_io: "vnc-rs" },
  acknowledged_advisories: [],
};

const CARGO_TOML = [
  "[package]",
  'name = "vnc-rs"',
  'version = "0.5.3"',
  "",
  "[dependencies]",
  'version = "9.9.9"',
].join("\n");

const README = `Fork of https://github.com/HsuJv/vnc-rs 0.5.3, commit ${SHA}.`;

const DOC = [
  "# Supply chain",
  "",
  "## Untrusted-input parser watchlist",
  "",
  "| Crate | Line | Lockfile | Parses | 1.0? | Hardening | Tests |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| `vnc-rs` | 0.5.3 | `Cargo.lock` | RFB | no | fork | fuzz |",
  "| `russh` | 0.61 | `Cargo.lock` | SSH | no | caps | fixtures |",
  "| `suppaftp` | 11 | `Cargo.lock`, `rdp-sidecar/Cargo.lock` | FTP | yes | v11 | fixture |",
  "",
  "## Next section",
  "| `ignored` | 1 | `Cargo.lock` | x | yes | x | x |",
].join("\n");

const LOCK = [
  "version = 4",
  "",
  "[[package]]",
  'name = "vnc-rs"',
  'version = "0.5.3"',
  "",
  "[[package]]",
  'name = "russh"',
  'version = "0.61.1"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  "",
  "[[package]]",
  'name = "suppaftp"',
  'version = "11.0.0"',
].join("\n");

const SIDECAR_LOCK = ["[[package]]", 'name = "suppaftp"', 'version = "11.2.0"'].join("\n");

function repo(overrides = {}) {
  return {
    manifest: { forks: [FORK] },
    vendorDirs: ["vendor/vnc-rs"],
    forkFiles: new Map([["vendor/vnc-rs", { cargoToml: CARGO_TOML, readme: README }]]),
    doc: DOC,
    locks: new Map([
      ["Cargo.lock", lockedVersions(LOCK)],
      ["rdp-sidecar/Cargo.lock", lockedVersions(SIDECAR_LOCK)],
    ]),
    ...overrides,
  };
}

describe("cargoPackage", () => {
  it("reads name and version from [package] only", () => {
    expect(cargoPackage(CARGO_TOML)).toEqual({ name: "vnc-rs", version: "0.5.3" });
  });
});

describe("lockedVersions", () => {
  it("maps every locked crate to its versions", () => {
    const locked = lockedVersions(`${LOCK}\n\n[[package]]\nname = "russh"\nversion = "0.60.0"`);
    expect(locked.get("russh")).toEqual(["0.61.1", "0.60.0"]);
    expect(locked.get("vnc-rs")).toEqual(["0.5.3"]);
  });
});

describe("isValidLine / onLine", () => {
  it("requires 0.y before 1.0 and accepts a bare major after", () => {
    expect(isValidLine("0.61")).toBe(true);
    expect(isValidLine("0.5.3")).toBe(true);
    expect(isValidLine("11")).toBe(true);
    expect(isValidLine("0")).toBe(false);
    expect(isValidLine("^0.61")).toBe(false);
  });

  it("matches versions on the line, not neighbouring lines", () => {
    expect(onLine("0.61.1", "0.61")).toBe(true);
    expect(onLine("0.610.0", "0.61")).toBe(false);
    expect(onLine("11.0.0", "11")).toBe(true);
    expect(onLine("1.0.0", "11")).toBe(false);
    expect(onLine("0.7.0-rc.10", "0.7")).toBe(true);
  });
});

describe("watchlistRows", () => {
  it("parses the table and stops at the next section", () => {
    const rows = watchlistRows(DOC);
    expect(rows.map((r) => r.crate)).toEqual(["vnc-rs", "russh", "suppaftp"]);
    expect(rows[2]).toEqual({
      crate: "suppaftp",
      line: "11",
      lockfiles: ["Cargo.lock", "rdp-sidecar/Cargo.lock"],
      stable: "yes",
    });
  });

  it("returns null when the section is missing", () => {
    expect(watchlistRows("# nothing")).toBeNull();
  });
});

describe("findProblems", () => {
  it("passes a consistent register and watchlist", () => {
    expect(findProblems(repo())).toEqual([]);
  });

  it("flags an unregistered vendored directory", () => {
    const problems = findProblems(repo({ vendorDirs: ["vendor/vnc-rs", "vendor/new-fork"] }));
    expect(problems).toEqual([expect.stringContaining("vendor/new-fork: vendored directory")]);
  });

  it("flags a registered fork whose directory is gone", () => {
    const problems = findProblems(
      repo({ forkFiles: new Map([["vendor/vnc-rs", { cargoToml: null, readme: null }]]) })
    );
    expect(problems).toEqual([expect.stringContaining("directory does not exist")]);
  });

  it("flags a re-based Cargo.toml the register does not know about", () => {
    const toml = CARGO_TOML.replace('version = "0.5.3"', 'version = "0.6.0"');
    const problems = findProblems(
      repo({ forkFiles: new Map([["vendor/vnc-rs", { cargoToml: toml, readme: README }]]) })
    );
    expect(problems).toEqual([expect.stringContaining('Cargo.toml version is "0.6.0"')]);
  });

  it("flags a README that does not record the fork base", () => {
    const problems = findProblems(
      repo({
        forkFiles: new Map([
          ["vendor/vnc-rs", { cargoToml: CARGO_TOML, readme: "A fork of vnc-rs 0.5.3." }],
        ]),
      })
    );
    expect(problems).toEqual([
      expect.stringContaining("base commit"),
      expect.stringContaining("upstream repository URL"),
    ]);
  });

  it("flags missing fields, short shas and link-less deltas", () => {
    const fork = {
      ...FORK,
      upstream_repo: "",
      reviewed_commit: "f8ac0ee",
      deltas: [{ summary: "x", refs: [] }],
    };
    const problems = findProblems(repo({ manifest: { forks: [fork] } }));
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing "upstream_repo"'),
        expect.stringContaining('"reviewed_commit" must be a full 40-hex'),
        expect.stringContaining("at least one link"),
      ])
    );
  });

  it("flags a watchlist line the lockfile has moved off", () => {
    const doc = DOC.replace("| `russh` | 0.61 |", "| `russh` | 0.60 |");
    expect(findProblems(repo({ doc }))).toEqual([
      expect.stringContaining("documented line 0.60, but Cargo.lock locks 0.61.1"),
    ]);
  });

  it("flags a watchlisted crate missing from a named lockfile", () => {
    const doc = DOC.replace(
      "| `russh` | 0.61 | `Cargo.lock` |",
      "| `russh` | 0.61 | `rdp-sidecar/Cargo.lock` |"
    );
    expect(findProblems(repo({ doc }))).toEqual([
      expect.stringContaining("not in rdp-sidecar/Cargo.lock"),
    ]);
  });

  it("flags a wrong 1.0 column", () => {
    const doc = DOC.replace("| SSH | no |", "| SSH | yes |");
    expect(findProblems(repo({ doc }))).toEqual([expect.stringContaining('"1.0?" says "yes"')]);
  });

  it("flags a fork with no watchlist row", () => {
    const doc = DOC.replace("| `vnc-rs` | 0.5.3 | `Cargo.lock` | RFB | no | fork | fuzz |\n", "");
    expect(findProblems(repo({ doc }))).toEqual([
      expect.stringContaining("registered fork `vnc-rs` has no watchlist row"),
    ]);
  });

  it("flags a missing watchlist section", () => {
    expect(findProblems(repo({ doc: "# Supply chain" }))).toEqual([
      expect.stringContaining('no "## Untrusted-input parser watchlist" section'),
    ]);
  });
});

describe("repository state", () => {
  it("the real register, forks, lockfiles and watchlist are consistent", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(findProblems(loadRepo(root))).toEqual([]);
  });
});
