/**
 * Dual-run of the visibility-condition and same-host golden vectors (#4198).
 *
 * `core/tests/schema_defaults_golden.rs` replays the fixtures under
 * `core/tests/fixtures/golden/schema_defaults/` against the Rust port. This
 * suite replays the `isFieldVisible`, `isSameHost` and `namesSameHost` files
 * against the TypeScript implementations, so the condition grammar
 * (`sameHostAs`, `sameNameAs`, `allOf`, `anyOf`) and both host rules are pinned
 * to one set of expected values on both sides.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SettingsField } from "@/types/schema";
import { isFieldVisible } from "./schemaDefaults";
import { isSameHost, isSameNamedHost } from "./sameHost";

interface GoldenCase {
  name: string;
  input: unknown;
  args: Record<string, unknown>;
  expected: unknown;
}

const FIXTURE_DIR = join(process.cwd(), "core/tests/fixtures/golden/schema_defaults");

function load(file: string): GoldenCase[] {
  const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as {
    cases: GoldenCase[];
  };
  return fixture.cases;
}

describe("isFieldVisible golden vectors", () => {
  it.each(load("is_field_visible.json").map((c) => [c.name, c] as const))("%s", (_, c) => {
    const settings = c.args.settings as Record<string, unknown>;
    expect(isFieldVisible(c.input as SettingsField, settings)).toBe(c.expected);
  });
});

describe("isSameHost golden vectors", () => {
  it.each(load("is_same_host.json").map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(isSameHost(c.input as string, c.args.fileHost as string)).toBe(c.expected);
  });
});

describe("isSameNamedHost golden vectors", () => {
  it.each(load("names_same_host.json").map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(isSameNamedHost(c.input as string, c.args.otherHost as string)).toBe(c.expected);
  });
});
