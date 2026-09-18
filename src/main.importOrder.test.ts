import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Locale-guard import-order enforcement (I18N-013).
 *
 * `src/utils/ensureValidLocale` sanitises an invalid `navigator.language`
 * (e.g. `"C"`/`"POSIX"`) on import, BEFORE any other module evaluates. In
 * particular `uplot` runs `new Intl.NumberFormat(navigator.language)` at module
 * scope, which throws `RangeError: invalid language tag: C` and aborts the whole
 * bundle before React mounts (#2646). The guard only works if it is the FIRST
 * import in `src/main.tsx` — if someone reorders the imports so another module
 * loads first, the guard silently stops protecting startup.
 *
 * Nothing else catches that reordering: `src/utils/locale.test.ts` only tests the
 * function's behaviour, not where it is wired in, and eslint has no rule pinning
 * the first import. This test is that missing guard-rail: it reads `main.tsx` and
 * asserts the guard is the first import statement. It is deterministic and
 * CI-gated via vitest.
 */

const MAIN_TSX = join(dirname(fileURLToPath(import.meta.url)), "main.tsx");

/** The side-effect import that MUST run before anything else in `main.tsx`. */
const GUARD_SPECIFIER = "./utils/ensureValidLocale";

/**
 * Strip line (`// ...`) and block (`/* ... *\/`) comments so a comment that
 * merely mentions "import" (the header block above the guard does) can never be
 * mistaken for a real import statement.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("main.tsx locale-guard import order (I18N-013)", () => {
  const source = readFileSync(MAIN_TSX, "utf8");
  const code = stripComments(source);

  it("still imports the locale guard", () => {
    expect(source).toContain(GUARD_SPECIFIER);
  });

  it("makes the locale guard the FIRST import statement", () => {
    // Match every ES import statement (side-effect `import "x";` and binding
    // `import X from "x";`), in source order.
    const importStatements = code.match(/^\s*import\b[\s\S]*?;/gm) ?? [];
    expect(importStatements.length).toBeGreaterThan(0);

    const first = importStatements[0];
    expect(first).toBeDefined();
    expect((first ?? "").trim()).toBe(`import "${GUARD_SPECIFIER}";`);
  });
});
