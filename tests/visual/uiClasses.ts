/**
 * Node-side helper for the `unstyled-class` assertion (#4712): the class names
 * the shared `src/components/ui/` primitives emit AND that some stylesheet under
 * `src/` styles. A class on screen from this set whose rule is not in any LOADED
 * stylesheet means the CSS lives in a chunk that has not been loaded yet (#4708).
 * Pure hook classes no stylesheet mentions are left out on purpose.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "..", "src");
const UI_DIR = join(SRC, "components", "ui");

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

/** Class-like tokens inside string and template literals of the ui/ sources. */
function primitiveClassTokens(): Set<string> {
  const tokens = new Set<string>();
  const sources = walk(UI_DIR, (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const literal of text.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
      const body = (literal[1] ?? literal[2] ?? literal[3] ?? "").replace(/\$\{[^}]*\}\S*/g, " ");
      for (const token of body.split(/\s+/)) {
        if (/^[a-z][a-z0-9]*(?:(?:-|__|--)[a-z0-9]+)+$/.test(token)) tokens.add(token);
      }
    }
  }
  return tokens;
}

/** The ui/ primitive classes that at least one `src/**\/*.css` file styles. */
export function styledPrimitiveClasses(): string[] {
  const css = walk(SRC, (f) => f.endsWith(".css"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  return [...primitiveClassTokens()].filter((cls) =>
    new RegExp(`\\.${cls.replace(/-/g, "\\-")}(?![\\w-])`).test(css)
  );
}
