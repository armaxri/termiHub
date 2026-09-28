// @vitest-environment node
import { describe, it, expect } from "vitest";
import path from "node:path";
import * as instrumentLib from "istanbul-lib-instrument";
import { transformWithEsbuild } from "vite";
import {
  COVERAGE_ENV,
  coverageEnabled,
  coveragePlugins,
  istanbulPlugin,
  parserPluginsFor,
  shouldInstrument,
} from "./vite-coverage-plugin.mjs";
import { mergeCoverageMaps, toLcov } from "./istanbul-to-lcov.mjs";

const ROOT = path.resolve("/repo");
const at = (rel) => path.join(ROOT, ...rel.split("/"));

describe("coverageEnabled / coveragePlugins", () => {
  it("is off unless the flag is explicitly set", async () => {
    expect(coverageEnabled({})).toBe(false);
    expect(coverageEnabled({ [COVERAGE_ENV]: "" })).toBe(false);
    expect(coverageEnabled({ [COVERAGE_ENV]: "0" })).toBe(false);
    expect(coverageEnabled({ [COVERAGE_ENV]: "1" })).toBe(true);
    expect(await coveragePlugins(ROOT, {})).toEqual([]);
  });

  it("returns the instrumenting plugin when on", async () => {
    const plugins = await coveragePlugins(ROOT, { [COVERAGE_ENV]: "1" });
    expect(plugins.map((p) => [p.name, p.enforce])).toEqual([
      ["termihub:istanbul-coverage", "pre"],
    ]);
  });
});

describe("shouldInstrument", () => {
  it("takes exactly the files vitest measures", () => {
    expect(shouldInstrument(at("src/App.tsx"), ROOT)).toBe(true);
    expect(shouldInstrument(at("src/utils/x.ts"), ROOT)).toBe(true);
    expect(shouldInstrument(at("src/utils/x.test.ts"), ROOT)).toBe(false);
    expect(shouldInstrument(at("src/App.test.tsx"), ROOT)).toBe(false);
    expect(shouldInstrument(at("src/test/setup.ts"), ROOT)).toBe(false);
    expect(shouldInstrument(at("src/types/x.d.ts"), ROOT)).toBe(false);
    expect(shouldInstrument(at("src/main.tsx"), ROOT)).toBe(false);
    expect(shouldInstrument(at("src/styles/a.css"), ROOT)).toBe(false);
    expect(shouldInstrument(at("node_modules/x/src/a.ts"), ROOT)).toBe(false);
    expect(shouldInstrument(path.resolve("/elsewhere/src/a.ts"), ROOT)).toBe(false);
    expect(shouldInstrument(`${at("src/a.ts")}?worker`, ROOT)).toBe(false);
    expect(shouldInstrument("\0virtual:src/a.ts", ROOT)).toBe(false);
  });

  it("parses JSX only in .tsx files", () => {
    expect(parserPluginsFor("a.ts", ["x"])).toEqual(["x", "typescript"]);
    expect(parserPluginsFor("a.tsx", ["x"])).toEqual(["x", "typescript", "jsx"]);
  });
});

describe("istanbulPlugin", () => {
  const plugin = istanbulPlugin(instrumentLib, ROOT);

  it("leaves files outside the measured set untouched", () => {
    expect(plugin.transform("export const a = 1;", at("src/a.test.ts"))).toBeNull();
  });

  it("instruments TSX without needing eval (CSP)", () => {
    const src = "export function A(p: { n: number }) {\n  return <b>{p.n}</b>;\n}\n";
    const out = plugin.transform(src, at("src/A.tsx"));
    expect(out.code).toContain("__coverage__");
    expect(out.code).not.toContain("new Function");
    expect(out.map).toBeTruthy();
  });

  it("records original-source lines through the esbuild type strip", async () => {
    const id = at("src/math.ts");
    const src = [
      "type N = number;", // 1
      "export function pick(a: N, b: N): N {", // 2
      "  if (a > b) {", // 3
      "    return a;", // 4
      "  }", // 5
      "  return b;", // 6
      "}", // 7
      "pick(1, 2);", // 8
      "",
    ].join("\n");
    const instrumented = plugin.transform(src, id);
    const js = await transformWithEsbuild(instrumented.code, id, { format: "cjs", loader: "ts" });
    const scope = {};
    new Function("globalThis", "exports", "module", js.code)(scope, {}, {});

    const { files } = mergeCoverageMaps([scope.__coverage__], ROOT);
    const lcov = toLcov(files);
    expect(lcov).toContain("SF:src/math.ts");
    expect(lcov).toContain("DA:3,1");
    expect(lcov).toContain("DA:4,0");
    expect(lcov).toContain("DA:6,1");
    expect(lcov).toContain("DA:8,1");
    expect(lcov).toContain("FNDA:1,pick");
    expect(lcov).toMatch(/BRDA:3,0,0,0\nBRDA:3,0,1,1/);
  });
});
