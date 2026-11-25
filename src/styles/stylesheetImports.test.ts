import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Every stylesheet under `src` is imported by something that runs (#6088). A
 * stylesheet whose last importer is deleted is dropped from the build without a
 * word, and what it styled falls apart (the file servers' activity panel did).
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return [path];
  });
}

const all = files(SRC);
const isTest = (path: string) => /\.test\.[jt]sx?$/.test(path);

/** The stylesheets that `importer` imports, resolved. */
function imported(importer: string): string[] {
  const text = readFileSync(importer, "utf8");
  const specs = [
    ...text.matchAll(/(?:^|\n)\s*import\s+(?:[^"';]*?from\s+)?["']([^"']+\.css)["']/g),
    ...text.matchAll(/@import\s+(?:url\()?["']([^"']+\.css)["']/g),
  ].map((match) => match[1]);
  return specs.map((spec) =>
    spec.startsWith("@/") ? join(SRC, spec.slice(2)) : resolve(dirname(importer), spec)
  );
}

describe("stylesheets", () => {
  it("are each imported by code or by another stylesheet", () => {
    const importers = all.filter(
      (path) => /\.(tsx?|css)$/.test(path) && !isTest(path) && !path.endsWith(".d.ts")
    );
    const used = new Set(importers.flatMap(imported));
    const sheets = all.filter((path) => path.endsWith(".css"));
    const orphans = sheets.filter((sheet) => !used.has(sheet)).map((s) => relative(SRC, s));
    expect(orphans).toEqual([]);
  });

  it("are found by the check", () => {
    expect(all.filter((path) => path.endsWith(".css")).length).toBeGreaterThan(100);
    expect(imported(join(SRC, "styles", "global.css"))).toContain(
      join(SRC, "styles", "variables.css")
    );
  });
});
