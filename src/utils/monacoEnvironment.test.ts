import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Guards for Monaco's worker wiring under the shipped CSP (#3632).
 *
 * Without `MonacoEnvironment.getWorker`, monaco-editor 0.57 starts its editor
 * worker from a `data:text/javascript` URL that `script-src` blocks — inside the
 * worker, where neither the document-level violation reporter nor
 * `test_csp.py` can see it. These tests pin the environment, its label map, and
 * which modules must install it first. The build setting that stops Vite
 * inlining scripts as `data:` URLs is guarded in viteBuildConfig.test.ts.
 */

function workerClass(kind: string) {
  return class {
    readonly kind = kind;
    constructor(public readonly options?: { name?: string }) {}
  };
}

vi.mock("monaco-editor/editor/editor.worker?worker", () => ({ default: workerClass("editor") }));
vi.mock("monaco-editor/language/css/css.worker?worker", () => ({ default: workerClass("css") }));
vi.mock("monaco-editor/language/html/html.worker?worker", () => ({ default: workerClass("html") }));
vi.mock("monaco-editor/language/json/json.worker?worker", () => ({ default: workerClass("json") }));
vi.mock("monaco-editor/language/typescript/ts.worker?worker", () => ({
  default: workerClass("ts"),
}));

const { monacoEnvironment } = await import("./monacoEnvironment");

interface Env {
  getWorker?: (workerId: string, label: string) => { kind: string; options?: { name?: string } };
  getWorkerUrl?: unknown;
}

describe("MonacoEnvironment (#3632)", () => {
  it("is installed on the global scope with getWorker, not getWorkerUrl", () => {
    const env = (self as unknown as { MonacoEnvironment?: Env }).MonacoEnvironment;
    expect(env).toBe(monacoEnvironment);
    expect(typeof env?.getWorker).toBe("function");
    // getWorkerUrl would route the editor worker back through Monaco's blob
    // bootstrap; the fix relies on getWorker returning bundled workers.
    expect(env?.getWorkerUrl).toBeUndefined();
  });

  it.each([
    ["editorWorkerService", "editor"],
    ["json", "json"],
    ["css", "css"],
    ["scss", "css"],
    ["less", "css"],
    ["html", "html"],
    ["handlebars", "html"],
    ["razor", "html"],
    ["typescript", "ts"],
    ["javascript", "ts"],
    ["some-future-label", "editor"],
  ])("serves label %s from the bundled %s worker", (label, kind) => {
    const worker = (monacoEnvironment as unknown as Required<Env>).getWorker("workerMain.js", label);
    expect(worker.kind).toBe(kind);
    expect(worker.options?.name).toBe(label);
  });
});

describe("monaco-editor entry points import the environment first (#3632)", () => {
  const SRC = join(__dirname, "..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  const importers = sourceFiles(SRC).filter((file) =>
    /from\s+["']monaco-editor["']/.test(readFileSync(file, "utf8"))
  );

  it("finds the monaco-editor importers", () => {
    expect(importers.length).toBeGreaterThan(0);
  });

  it.each(importers.map((file) => [relative(SRC, file), file]))(
    "%s imports @/utils/monacoEnvironment before monaco-editor",
    (_name, file) => {
      const text = readFileSync(file, "utf8");
      const envAt = text.indexOf('import "@/utils/monacoEnvironment";');
      const monacoAt = text.search(/from\s+["']monaco-editor["']/);
      expect(envAt).toBeGreaterThanOrEqual(0);
      expect(envAt).toBeLessThan(monacoAt);
    }
  );
});
