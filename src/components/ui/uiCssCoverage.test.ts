import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path, { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Guard: every class name the shared `ui/` primitives emit is styled by a
 * stylesheet in the main (non-lazy) bundle (#4708).
 *
 * The Settings panel and the connection editor are lazy chunks. When the
 * `settings-form__field*` rules the `Field` primitive renders lived in
 * `ConnectionEditor.css`, Settings rendered every field unstyled until a
 * connection editor had been opened once. A primitive's styles must therefore
 * live in CSS the primitive layer imports itself (`ui.css`, `Toast/toast.css`)
 * or in the global stylesheet chain imported by `main.tsx` — never in a
 * consumer's stylesheet.
 */

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(UI_DIR, "..", "..");
const MAIN_ENTRY = join(SRC_DIR, "main.tsx");

/**
 * `file` relative to `base`, with forward slashes on every platform (#4975).
 * `pathApi` is injectable so the Windows behaviour can be checked on POSIX.
 */
function posixRelative(base: string, file: string, pathApi: typeof path.posix = path): string {
  return pathApi.relative(base, file).split(pathApi.sep).join("/");
}

/** Class families owned by the primitive layer. */
const PRIMITIVE_CLASS = /^(?:ui-|settings-form)[a-z0-9_-]*[a-z0-9]$/;

/** Recursively collect files under `dir` whose basename passes `match`. */
function collectFiles(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full, match));
    else if (match(entry)) out.push(full);
  }
  return out;
}

/** Non-test TypeScript sources of the primitive layer. */
function primitiveSources(): string[] {
  return collectFiles(
    UI_DIR,
    (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")
  );
}

/** Relative `.css` imports (`import "./x.css"` / `@import "./x.css"`) of a file. */
function cssImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)(?:@?import)\s+["']([^"']+\.css)["']/g)) {
    const path = resolve(dirname(file), m[1]);
    if (existsSync(path)) out.push(path);
  }
  return out;
}

/** A stylesheet plus everything it (transitively) `@import`s. */
function withImports(css: string, seen = new Set<string>()): Set<string> {
  if (seen.has(css)) return seen;
  seen.add(css);
  for (const dep of cssImports(css)) withImports(dep, seen);
  return seen;
}

/** Stylesheets guaranteed to be in the main bundle. */
function alwaysLoadedStylesheets(): Set<string> {
  const sheets = new Set<string>();
  for (const css of cssImports(MAIN_ENTRY)) withImports(css, sheets);
  for (const src of primitiveSources()) {
    for (const css of cssImports(src)) withImports(css, sheets);
  }
  return sheets;
}

/** Strip block comments so a class mentioned only in a comment does not count. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Class names emitted by a primitive source: whitespace-separated tokens of its
 * static string literals that belong to a primitive class family. Dynamic
 * template pieces (`ui-btn--${variant}`) end in `-` and are skipped; their
 * concrete values appear as literals in the same file's lookup tables.
 */
function emittedClasses(file: string): Set<string> {
  const text = readFileSync(file, "utf8").replace(/^\s*import .*$/gm, "");
  const out = new Set<string>();
  for (const m of text.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
    const literal = m[1] ?? m[2] ?? m[3] ?? "";
    for (const piece of literal.split(/\$\{[^}]*\}/)) {
      for (const token of piece.split(/\s+/)) {
        if (PRIMITIVE_CLASS.test(token)) out.add(token);
      }
    }
  }
  return out;
}

/** True when `css` has a selector using `.className` (not as a prefix of a longer class). */
function definesClass(css: string, className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}(?![a-zA-Z0-9_-])`).test(css);
}

describe("posixRelative (#4975)", () => {
  it("normalises native Windows separators to forward slashes", () => {
    const base = "C:\\repo\\src";
    const file = "C:\\repo\\src\\components\\ui\\ui.css";
    expect(posixRelative(base, file, path.win32)).toBe("components/ui/ui.css");
  });

  it("leaves POSIX paths unchanged", () => {
    expect(posixRelative("/repo/src", "/repo/src/styles/global.css", path.posix)).toBe(
      "styles/global.css"
    );
  });
});

describe("ui primitive CSS is always loaded (#4708)", () => {
  const sheets = alwaysLoadedStylesheets();
  const corpus = Array.from(sheets)
    .map((s) => stripComments(readFileSync(s, "utf8")))
    .join("\n");

  it("loads ui.css and the global stylesheet chain", () => {
    const names = Array.from(sheets).map((s) => posixRelative(SRC_DIR, s));
    expect(names).toContain("components/ui/ui.css");
    expect(names).toContain("styles/global.css");
  });

  it("finds the Field primitive's settings-variant classes", () => {
    const field = emittedClasses(join(UI_DIR, "Field.tsx"));
    expect(field).toContain("settings-form__field");
    expect(field).toContain("settings-form__hint");
    expect(field).toContain("settings-form__field--inline");
  });

  it("defines every class a ui primitive emits in an always-loaded stylesheet", () => {
    const missing: string[] = [];
    for (const src of primitiveSources()) {
      for (const cls of emittedClasses(src)) {
        if (!definesClass(corpus, cls)) missing.push(`${posixRelative(UI_DIR, src)}: .${cls}`);
      }
    }
    expect(
      missing,
      "These classes are emitted by src/components/ui/* but have no rule in ui.css, " +
        "a stylesheet a primitive imports, or the global CSS chain imported by main.tsx. " +
        "Move their rules there — a consumer's stylesheet may be in a lazy chunk."
    ).toEqual([]);
  });
});
