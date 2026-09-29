import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

// PERF-003: the non-terminal tab surfaces are code-split out of the eager entry
// chunk via `React.lazy(() => import(path).then((m) => ({ default: m.Name })))`
// in SplitView. That contract has two silent failure modes once a barrel/path is
// refactored: the dynamic-import path drifting, or the named export being renamed
// so `m.Name` resolves to `undefined` (React.lazy would then throw only at render,
// inside a Suspense boundary, at runtime).
//
// This test reads SplitView's real loaders from its source and checks each target
// module statically: the path resolves to a file, and that file (or the barrel it
// re-exports from) declares `export function <Name>`, i.e. a function component.
//
// It deliberately does NOT `await import()` the surfaces (#3865). A real dynamic
// import makes vitest transform and evaluate each surface's whole module graph;
// SettingsPanel alone took ~2 s standalone and ~7 s inside a loaded full-suite
// run, so the test timed out whenever the machine was busy. Reading source is
// independent of machine load. tsc still type-checks the real `import()` paths
// and `m.Name` accesses in SplitView.tsx.

const SRC_ROOT = join(process.cwd(), "src");
const SPLIT_VIEW = join(SRC_ROOT, "components/SplitView/SplitView.tsx");

/** Matches `lazy(() => import("<path>").then((m) => ({ default: m.<Name> })))`. */
const LAZY_LOADER =
  /lazy\(\s*\(\)\s*=>\s*import\(\s*"([^"]+)"\s*\)\s*\.then\(\s*\(m\)\s*=>\s*\(\{\s*default:\s*m\.(\w+),?\s*\}\)\s*\)\s*\)/g;

interface LazyLoader {
  path: string;
  name: string;
}

function readLazyLoaders(): LazyLoader[] {
  const source = readFileSync(SPLIT_VIEW, "utf8");
  return [...source.matchAll(LAZY_LOADER)].map(([, path, name]) => ({ path, name }));
}

/** Resolves an `@/` or relative module specifier to a source file, like Vite does. */
function resolveModule(specifier: string, fromDir: string): string | undefined {
  const base = specifier.startsWith("@/")
    ? join(SRC_ROOT, specifier.slice(2))
    : join(fromDir, specifier);
  const candidates = [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")];
  return candidates.find((file) => existsSync(file));
}

/**
 * Whether `file` exports `name` as a function declaration, following
 * `export { name } from "..."` re-exports (barrels) a few levels deep.
 */
function exportsFunction(file: string, name: string, depth = 0): boolean {
  if (depth > 4) return false;
  const source = readFileSync(file, "utf8");
  if (new RegExp(`^export function ${name}\\b`, "m").test(source)) return true;
  const reExport = new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\} from "([^"]+)"`, "m");
  const match = reExport.exec(source);
  if (!match) return false;
  const target = resolveModule(match[1], dirname(file));
  return target !== undefined && exportsFunction(target, name, depth + 1);
}

const loaders = readLazyLoaders();

describe("SplitView lazy tab surfaces (PERF-003)", () => {
  it("finds every lazy surface loader in SplitView", () => {
    // FileEditor plus the eleven PERF-003 surfaces. If a loader is reshaped so the
    // pattern no longer matches, this fails instead of silently checking fewer.
    const lazyCallCount = readFileSync(SPLIT_VIEW, "utf8").match(/\blazy\(/g)?.length ?? 0;
    expect(loaders.length).toBe(lazyCallCount);
    expect(loaders.map((l) => l.name)).toEqual(
      expect.arrayContaining([
        "FileEditor",
        "SettingsPanel",
        "ConnectionEditor",
        "LogViewer",
        "TunnelEditor",
        "WorkspaceEditor",
        "NetworkDiagnosticPanel",
        "TransferView",
        "PluginDetailPanel",
        "RemoteDesktopTab",
        "FileBrowserTab",
        "AgentErrorTab",
      ])
    );
  });

  it.each(loaders.map((l) => [l.name, l.path] as const))(
    "%s: import(%s) resolves to a module exporting the component",
    (name, path) => {
      const file = resolveModule(path, dirname(SPLIT_VIEW));
      // A drifted path resolves to no file.
      expect(file, `no module for ${path}`).toBeDefined();
      // A renamed export would make `m.${name}` undefined at render time.
      expect(exportsFunction(file!, name), `${path} does not export function ${name}`).toBe(true);
    }
  );

  it("rejects a drifted path and a renamed export", () => {
    const splitViewDir = dirname(SPLIT_VIEW);
    expect(resolveModule("@/components/Settings/NoSuchPanel", splitViewDir)).toBeUndefined();
    const settings = resolveModule("@/components/Settings/SettingsPanel", splitViewDir)!;
    expect(exportsFunction(settings, "SettingsPanel")).toBe(true);
    expect(exportsFunction(settings, "SettingsPanelRenamed")).toBe(false);
    // Barrel re-export is followed.
    const editorBarrel = resolveModule("@/components/FileEditor", splitViewDir)!;
    expect(exportsFunction(editorBarrel, "FileEditor")).toBe(true);
  });
});
