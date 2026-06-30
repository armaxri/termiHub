import { describe, it, expect } from "vitest";
import {
  minorOf,
  parseCargoCrateVersion,
  tauriPairs,
  findDrift,
} from "./check-tauri-version-drift.mjs";

describe("minorOf", () => {
  it("extracts the major.minor portion of a semver", () => {
    expect(minorOf("2.11.2")).toBe("2.11");
    expect(minorOf("2.7.1")).toBe("2.7");
    expect(minorOf("10.0.0")).toBe("10.0");
  });

  it("tolerates a leading v and surrounding whitespace", () => {
    expect(minorOf("v2.5.1")).toBe("2.5");
    expect(minorOf("  2.5.1  ")).toBe("2.5");
  });

  it("returns null for unparseable or non-string input", () => {
    expect(minorOf("")).toBeNull();
    expect(minorOf("not-a-version")).toBeNull();
    expect(minorOf(null)).toBeNull();
    expect(minorOf(undefined)).toBeNull();
  });
});

describe("parseCargoCrateVersion", () => {
  const cargoLock = [
    "[[package]]",
    'name = "tauri"',
    'version = "2.11.2"',
    'dependencies = ["tauri-utils"]',
    "",
    "[[package]]",
    'name = "tauri-plugin-fs"',
    'version = "2.5.1"',
    "",
    "[[package]]",
    'name = "tauri-utils"',
    'version = "2.0.0"',
  ].join("\n");

  it("reads the exact crate's resolved version", () => {
    expect(parseCargoCrateVersion(cargoLock, "tauri")).toBe("2.11.2");
    expect(parseCargoCrateVersion(cargoLock, "tauri-plugin-fs")).toBe("2.5.1");
  });

  it("does not confuse a crate with a longer-named neighbour", () => {
    // "tauri" must not match the "tauri-utils" or "tauri-plugin-fs" blocks.
    expect(parseCargoCrateVersion(cargoLock, "tauri")).toBe("2.11.2");
  });

  it("returns null for an absent crate or bad input", () => {
    expect(parseCargoCrateVersion(cargoLock, "tauri-plugin-nope")).toBeNull();
    expect(parseCargoCrateVersion(null, "tauri")).toBeNull();
  });
});

describe("tauriPairs", () => {
  it("maps api to tauri and plugins to tauri-plugin-*, skipping the cli", () => {
    const pkg = {
      dependencies: {
        "@tauri-apps/api": "^2.11.0",
        "@tauri-apps/plugin-dialog": "^2.7.1",
        "@tauri-apps/plugin-fs": "^2.5.1",
        react: "^18.0.0",
      },
      devDependencies: {
        "@tauri-apps/cli": "^2.11.2",
      },
    };
    expect(tauriPairs(pkg)).toEqual([
      { npm: "@tauri-apps/api", crate: "tauri" },
      { npm: "@tauri-apps/plugin-dialog", crate: "tauri-plugin-dialog" },
      { npm: "@tauri-apps/plugin-fs", crate: "tauri-plugin-fs" },
    ]);
  });

  it("returns an empty list when there are no @tauri-apps deps", () => {
    expect(tauriPairs({ dependencies: { react: "^18.0.0" } })).toEqual([]);
    expect(tauriPairs({})).toEqual([]);
  });
});

describe("findDrift", () => {
  it("treats equal major/minor as ok even when patch differs", () => {
    const { ok, drift, skipped } = findDrift([
      { npm: "@tauri-apps/api", crate: "tauri", npmVersion: "2.11.0", crateVersion: "2.11.2" },
    ]);
    expect(ok).toHaveLength(1);
    expect(drift).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });

  it("flags a major/minor mismatch as drift", () => {
    const { drift } = findDrift([
      { npm: "@tauri-apps/api", crate: "tauri", npmVersion: "2.10.1", crateVersion: "2.11.2" },
      {
        npm: "@tauri-apps/plugin-fs",
        crate: "tauri-plugin-fs",
        npmVersion: "2.4.5",
        crateVersion: "2.5.1",
      },
    ]);
    expect(drift.map((d) => d.npm)).toEqual(["@tauri-apps/api", "@tauri-apps/plugin-fs"]);
  });

  it("skips pairs where a version could not be resolved", () => {
    const { ok, drift, skipped } = findDrift([
      { npm: "@tauri-apps/api", crate: "tauri", npmVersion: null, crateVersion: "2.11.2" },
      {
        npm: "@tauri-apps/plugin-x",
        crate: "tauri-plugin-x",
        npmVersion: "2.5.1",
        crateVersion: null,
      },
    ]);
    expect(ok).toHaveLength(0);
    expect(drift).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });
});
