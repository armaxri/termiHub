/**
 * Flags allowlist entries that no test used (#4712). The entry's bug is fixed,
 * so its fix PR should delete it. Warns rather than fails: a fix can land
 * before or after this suite, and the warning names the entry to delete. Only
 * a complete, non-strict run counts. A `--grep` subset, or VISUAL_STRICT
 * switching entries off, would report false positives.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ALLOWLIST } from "./allowlist";
import { EXPECTED_TESTS, USAGE_DIR } from "./surfaces";

export default function globalTeardown(): void {
  if (process.env.VISUAL_STRICT || !existsSync(USAGE_DIR)) return;
  const files = readdirSync(USAGE_DIR).filter((f) => f.endsWith(".json"));
  if (files.length < EXPECTED_TESTS) return;
  const used = new Set<number>();
  for (const file of files) {
    for (const index of JSON.parse(readFileSync(join(USAGE_DIR, file), "utf8")) as number[]) {
      used.add(index);
    }
  }
  ALLOWLIST.forEach((entry, index) => {
    if (used.has(index)) return;
    const message =
      `visual allowlist entry for #${entry.issue} (${entry.kind} ${entry.surface} ${entry.match}) ` +
      `matched nothing: #${entry.issue} looks fixed, delete the entry in tests/visual/allowlist.ts`;
    console.warn(
      process.env.GITHUB_ACTIONS
        ? `::warning title=Stale allowlist entry::${message}`
        : `WARNING: ${message}`
    );
  });
}
