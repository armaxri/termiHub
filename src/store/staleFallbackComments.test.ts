import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, relative, sep } from "path";
import { fileURLToPath } from "url";

/**
 * Stale-comment guard (DEAD2-005, #4371).
 *
 * The projection regions are authoritative: the render cuts' `appStore` seed,
 * faithful-mirror gate and `appStore` fallback were all removed. Comments that
 * still say a value is read from a region "when it faithfully mirrors appStore,
 * else appStore verbatim", or that it "falls back to appStore", describe code
 * that no longer exists and mislead the next reader. This test fails when such a
 * phrase reappears in production source.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Phrases that only ever described the removed fallback / mirror-gate path. */
const STALE_PHRASES: readonly RegExp[] = [
  /else\s+(?:from\s+)?`?appStore`?\s+verbatim/i,
  /falls?\s+back\s+to\s+`?appStore`?/i,
  /(?:faithfully\s+)?mirrors\s+`?appStore`?,?\s+else/i,
  /when\s+it\s+(?:faithfully\s+)?mirrors\s+`?appStore`?/i,
  /projectedReconnectMirrors/,
];

/** Production source files: `.ts`/`.tsx` under `src/`, minus tests and doubles. */
function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const rel = relative(SRC_DIR, full).split(sep).join("/");
      if (rel === "test" || rel === "types/generated") continue;
      out.push(...productionSources(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("stale appStore-fallback comments (DEAD2-005)", () => {
  it("no production source describes the removed appStore fallback or mirror gate", () => {
    const hits: string[] = [];
    for (const file of productionSources(SRC_DIR)) {
      const lines = readFileSync(file, "utf8").split("\n");
      // Join each line with the next so a phrase wrapped across a comment line
      // break is still caught.
      lines.forEach((line, i) => {
        const pair = `${line} ${(lines[i + 1] ?? "").replace(/^\s*(?:\/\/|\*)\s?/, "")}`;
        if (STALE_PHRASES.some((re) => re.test(pair))) {
          hits.push(`${relative(SRC_DIR, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
