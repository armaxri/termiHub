import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import path from "path";
import {
  checkRepo,
  compareRegions,
  extractClientRegions,
  extractDocRegions,
  extractSharedRegions,
  findStatusParagraph,
  isTestFile,
} from "./check-adr14-regions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SOURCES = {
  "tunnel/projection.rs": 'pub const TUNNELS_REGION: &str = "tunnels";',
  "plugin_sandbox_projection/mod.rs": [
    'pub const PLUGIN_SANDBOX_REGION: &str = "plugin-sandbox";',
    "projector.register_region(PLUGIN_SANDBOX_REGION, snapshot(&host));",
  ].join("\n"),
  "commands/projection_diag.rs": 'pub const DIAG_REGION: &str = "diag.counter";',
  "boot/mod.rs": [
    "projection_state.projector.register_region(",
    "    tunnel::projection::TUNNELS_REGION,",
    "    initial,",
    ");",
    "projection_state.projector.register_region(",
    "    commands::projection_diag::DIAG_REGION,",
    "    diag,",
    ");",
  ].join("\n"),
  "layout/projection.rs": [
    "pub fn layout_region(client_id: &str) -> String {",
    '    format!("layout@{client_id}")',
    "}",
  ].join("\n"),
  // Test-only code must not contribute regions.
  "layout/projection_tests.rs": [
    'const GHOST_REGION: &str = "ghost";',
    "projector.register_region(GHOST_REGION, json!({}));",
    'fn ghost_region(client_id: &str) -> String { format!("ghost@{client_id}") }',
  ].join("\n"),
};

const DOC = [
  "# Architecture",
  "",
  "### ADR-14: Backend Projection Regions",
  "",
  "**Context:** `unrelated` text.",
  "",
  "**Status: complete.** Seeded by `boot::seed_projection_regions`",
  "(`src-tauri/src/boot/mod.rs`): `tunnels` and the read-only `plugin-sandbox` region.",
  "Client-scoped: `layout@<clientId>`. (The test bridge also seeds `diag.counter`.)",
  "",
  "**Rationale:** `ignored`.",
].join("\n");

describe("isTestFile", () => {
  it("recognises test modules and test directories", () => {
    expect(isTestFile("layout/projection_tests.rs")).toBe(true);
    expect(isTestFile("plugin_sandbox_projection/tests.rs")).toBe(true);
    expect(isTestFile("foo/tests/bar.rs")).toBe(true);
    expect(isTestFile("layout/projection.rs")).toBe(false);
    expect(isTestFile("boot/mod.rs")).toBe(false);
  });
});

describe("extractSharedRegions", () => {
  it("follows *_REGION consts passed to register_region, skipping test files", () => {
    expect(extractSharedRegions(SOURCES)).toEqual({
      regions: ["diag.counter", "plugin-sandbox", "tunnels"],
      problems: [],
    });
  });

  it("accepts publish_with with a string literal", () => {
    const { regions } = extractSharedRegions({ "a.rs": 'p.publish_with("raw", || v);' });
    expect(regions).toEqual(["raw"]);
  });

  it("reports a registered const with no definition", () => {
    const { problems } = extractSharedRegions({ "a.rs": "p.register_region(MISSING_REGION, v);" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("`MISSING_REGION`");
  });
});

describe("extractClientRegions", () => {
  it("reads the domain from fn *_region format! helpers, skipping test files", () => {
    expect(extractClientRegions(SOURCES)).toEqual(["layout"]);
  });
});

describe("findStatusParagraph / extractDocRegions", () => {
  it("returns only the ADR-14 status paragraph", () => {
    const status = findStatusParagraph(DOC);
    expect(status.line).toBe(7);
    expect(status.text).not.toContain("unrelated");
    expect(status.text).not.toContain("ignored");
  });

  it("extracts kebab-case and client-scoped names, excluding diag.counter", () => {
    expect(extractDocRegions(findStatusParagraph(DOC).text)).toEqual({
      shared: ["plugin-sandbox", "tunnels"],
      client: ["layout"],
    });
  });

  it("returns null without an ADR-14 status paragraph", () => {
    expect(
      findStatusParagraph("### ADR-14: X\n\nno status\n\n### ADR-15: Y\n\n**Status:** z")
    ).toBe(null);
  });
});

describe("compareRegions", () => {
  const doc = { shared: ["plugin-sandbox", "tunnels"], client: ["layout"] };

  it("passes when both sides agree (ignoring test-only regions)", () => {
    const code = { shared: ["diag.counter", "plugin-sandbox", "tunnels"], client: ["layout"] };
    expect(compareRegions(code, doc, "d:1")).toEqual([]);
  });

  it("reports a region added in code but not in the ADR", () => {
    const code = { shared: ["plugin-sandbox", "tunnels", "new-thing"], client: ["layout"] };
    const problems = compareRegions(code, doc, "d:1");
    expect(problems).toEqual([
      "d:1: shared region `new-thing` is registered in code but missing from ADR-14",
    ]);
  });

  it("reports a renamed region on both sides", () => {
    const code = { shared: ["plugin-sandbox", "tunnels"], client: ["panes"] };
    const problems = compareRegions(code, doc, "d:1");
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("`panes@<clientId>` exists in code but is missing");
    expect(problems[1]).toContain("`layout@<clientId>` is named in ADR-14 but not defined");
  });
});

describe("checkRepo on a fixture repo", () => {
  let dir;
  const makeRepo = (doc) => {
    dir = mkdtempSync(path.join(tmpdir(), "adr14-"));
    for (const [rel, text] of Object.entries(SOURCES)) {
      const abs = path.join(dir, "src-tauri/src", rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs/architecture.md"), doc);
    return dir;
  };
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes when the ADR matches the code", () => {
    const result = checkRepo(makeRepo(DOC));
    expect(result).toEqual({
      problems: [],
      shared: ["plugin-sandbox", "tunnels"],
      client: ["layout"],
    });
  });

  it("fails when the ADR misses a region", () => {
    const { problems } = checkRepo(
      makeRepo(DOC.replace(" and the read-only `plugin-sandbox`", ""))
    );
    expect(problems).toEqual([
      "docs/architecture.md:7: shared region `plugin-sandbox` is registered in code but missing from ADR-14",
    ]);
  });
});

describe("the real repo", () => {
  it("names every projection region in ADR-14", () => {
    const { problems, shared, client } = checkRepo(ROOT);
    expect(problems).toEqual([]);
    expect(shared.length).toBeGreaterThan(0);
    expect(client.length).toBeGreaterThan(0);
    expect(shared).not.toContain("diag.counter");
  });
});
