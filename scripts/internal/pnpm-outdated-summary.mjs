#!/usr/bin/env node
// Summarize a `pnpm outdated --format json` payload as a Markdown table for the
// report-only Dependency Report workflow (#5011). Information only: it never
// fails, whatever the payload holds; an unparseable payload yields a warning
// line instead of a table.
//
// Usage: node scripts/internal/pnpm-outdated-summary.mjs <outdated.json>
// Prints the Markdown; the workflow tees it into $GITHUB_STEP_SUMMARY.

import { readFileSync } from "fs";
import { isMainModule } from "./is-main-module.mjs";

/**
 * Render the outdated-packages section.
 *
 * @param {string} text - raw `pnpm outdated --format json` output (may be empty).
 * @returns {string} Markdown section, ending with a newline.
 */
export function renderOutdated(text) {
  const out = ["### Outdated npm packages", ""];
  let data;
  try {
    data = JSON.parse(text.trim() === "" ? "{}" : text);
  } catch {
    data = null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    out.push(":warning: Could not parse the `pnpm outdated` output; see the step log.");
  } else {
    const rows = Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
    if (rows.length === 0) {
      out.push("All direct npm dependencies are up to date.");
    } else {
      out.push(`${rows.length} direct package(s) have a newer version:`, "");
      out.push("| Package | Current | Wanted | Latest | Type |");
      out.push("| --- | --- | --- | --- | --- |");
      for (const [name, r] of rows) {
        const deprecated = r?.isDeprecated ? " (deprecated)" : "";
        out.push(
          `| ${name}${deprecated} | ${r?.current ?? "?"} | ${r?.wanted ?? "?"} | ` +
            `${r?.latest ?? "?"} | ${r?.dependencyType ?? "?"} |`
        );
      }
    }
  }
  out.push("", "npm advisories are reported by the Security Audit workflow (`pnpm audit`).", "");
  return out.join("\n");
}

if (isMainModule(import.meta.url)) {
  const file = process.argv[2];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = "not json";
  }
  process.stdout.write(renderOutdated(text));
}
