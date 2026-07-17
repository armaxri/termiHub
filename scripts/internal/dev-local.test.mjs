import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_DEV_PORT, readDevLocal, resolveDevPort } from "./dev-local.mjs";

/**
 * Every case runs against a throwaway repo root. The real checkouts' own
 * dev.local.json is read-only infrastructure — never write to or remove it.
 */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "termihub-dev-local-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a dev.local.json into the temp root. */
function writeDevLocal(contents) {
  writeFileSync(
    join(root, "dev.local.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents)
  );
}

describe("resolveDevPort", () => {
  it("falls back to 1420 with no dev.local.json (fresh clone / CI)", () => {
    expect(resolveDevPort({ repoRoot: root, env: {} })).toBe(DEFAULT_DEV_PORT);
    expect(DEFAULT_DEV_PORT).toBe(1420);
  });

  it("reads dev_port from dev.local.json when the env var is unset", () => {
    // The #1588 regression: this returned 1420 — checkout 0's port — in every
    // checkout, because only scripts/dev.sh ever read the file.
    writeDevLocal({ dev_port: 1450, dev_name: "dev3" });
    expect(resolveDevPort({ repoRoot: root, env: {} })).toBe(1450);
  });

  it("lets TERMIHUB_DEV_PORT win over dev.local.json", () => {
    // scripts/dev.sh exports the var (honouring its own CLI port argument);
    // that override must keep winning.
    writeDevLocal({ dev_port: 1450 });
    expect(resolveDevPort({ repoRoot: root, env: { TERMIHUB_DEV_PORT: "1499" } })).toBe(1499);
  });

  it("uses TERMIHUB_DEV_PORT with no dev.local.json present", () => {
    expect(resolveDevPort({ repoRoot: root, env: { TERMIHUB_DEV_PORT: "1499" } })).toBe(1499);
  });

  it("ignores an unusable env value and falls through to the file", () => {
    writeDevLocal({ dev_port: 1450 });
    for (const bad of ["", "   ", "not-a-port", "0", "70000", "14.5"]) {
      expect(resolveDevPort({ repoRoot: root, env: { TERMIHUB_DEV_PORT: bad } })).toBe(1450);
    }
  });

  it("ignores an unusable dev_port and falls through to the default", () => {
    for (const bad of [0, 70000, "nope", null, true, 14.5]) {
      writeDevLocal({ dev_port: bad });
      expect(resolveDevPort({ repoRoot: root, env: {} })).toBe(DEFAULT_DEV_PORT);
    }
  });

  it("accepts a numeric string dev_port", () => {
    writeDevLocal({ dev_port: "1450" });
    expect(resolveDevPort({ repoRoot: root, env: {} })).toBe(1450);
  });

  it("treats a malformed dev.local.json as absent rather than throwing", () => {
    writeDevLocal("{ this is not json");
    expect(resolveDevPort({ repoRoot: root, env: {} })).toBe(DEFAULT_DEV_PORT);
  });
});

describe("readDevLocal", () => {
  it("returns {} when the file is missing", () => {
    expect(readDevLocal(root)).toEqual({});
  });

  it("returns the parsed object", () => {
    writeDevLocal({ dev_port: 1450, dev_name: "dev3", compose_project: "termihub-test-3" });
    expect(readDevLocal(root)).toEqual({
      dev_port: 1450,
      dev_name: "dev3",
      compose_project: "termihub-test-3",
    });
  });

  it("returns {} for valid JSON that is not an object", () => {
    for (const contents of ["[1, 2]", '"string"', "null", "42"]) {
      writeDevLocal(contents);
      expect(readDevLocal(root)).toEqual({});
    }
  });
});
