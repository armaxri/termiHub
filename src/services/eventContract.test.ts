/**
 * Tauri event-name contract (TFE2-006, #4344).
 *
 * `invoke` names are cross-checked by `scripts/internal/check-invoke-contract.mjs`,
 * but event channels are plain strings on both sides: a frontend `listen("x")`
 * whose backend `emit("x", ..)` was renamed or removed silently never fires,
 * and a backend `emit` with no listener is dead traffic (the 1 Hz legacy
 * tunnel-stats event, DEAD2-004 / PERF2-007).
 *
 * The backend side is `src/test/fixtures/wire/events.json`: every event name
 * the production Rust code emits, written by the `ipc_wire_fixtures` test
 * (`src-tauri/src/ipc_wire_fixtures/event_names.rs`) and kept current by the
 * `code-quality` CI job. This suite parses every production `listen(..)` /
 * `once(..)` call (from `@tauri-apps/api/event`) under `src/`, plus every call of a
 * forwarding wrapper such as `useTauriListener("x", ..)` (#4590), and checks both
 * directions against that list.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import eventsFixture from "@/test/fixtures/wire/events.json";
import { TAURI_EVENT } from "./eventNames";

const SRC_ROOT = path.resolve(__dirname, "..");

/**
 * Backend-emitted events with no frontend `listen()` on purpose, each with the
 * reason. Keep it short: an event nothing listens to is dead traffic.
 */
const EMITTED_WITHOUT_LISTENER: Record<string, string> = {};

/** Whether a frontend file is production code (tests / test setup excluded). */
function isProductionFile(rel: string): boolean {
  if (!/\.(ts|tsx)$/.test(rel) || rel.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\.tsx?$/.test(rel)) return false;
  return !rel.startsWith("test/") && !rel.includes("__tests__/") && !rel.includes("__mocks__/");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

interface ListenSite {
  where: string;
  name: string | null;
  expr: string;
}

/** `TAURI_EVENT.someKey` → its value. */
function tauriEventValue(expr: ts.Expression): string | null {
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "TAURI_EVENT"
  ) {
    const value = (TAURI_EVENT as Record<string, string>)[expr.name.text];
    return value ?? null;
  }
  return null;
}

/** Parse every production source file once. */
function parseSources(): Source[] {
  return walk(SRC_ROOT)
    .map((full) => path.relative(SRC_ROOT, full).split(path.sep).join("/"))
    .filter(isProductionFile)
    .map((rel) => {
      const text = fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");
      const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      return { rel, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind) };
    });
}

/** Every `const NAME = "literal"` / `= TAURI_EVENT.x` across the sources, by name. */
function collectStringConsts(sources: { sf: ts.SourceFile }[]): Map<string, Set<string>> {
  const consts = new Map<string, Set<string>>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    ) {
      const init = node.initializer;
      const value = ts.isStringLiteralLike(init) ? init.text : tauriEventValue(init);
      if (value !== null) {
        if (!consts.has(node.name.text)) consts.set(node.name.text, new Set());
        consts.get(node.name.text)?.add(value);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const { sf } of sources) visit(sf);
  return consts;
}

/**
 * Generic wrappers whose inner `listen(<param>, ..)` forwards a caller-supplied
 * event name (mirrors the backend's `FORWARDING_SITES` in
 * `src-tauri/src/ipc_wire_fixtures/event_names.rs`). The inner call is not a
 * listen site itself; instead every call of the exported `via` function, from
 * any file that imports it, is scanned as a listen site with its first argument
 * as the event name — so `useTauriListener("x", ..)` is held to the same
 * contract as `listen("x", ..)`.
 */
const FORWARDING_SITES: { file: string; expr: string; via: string }[] = [
  { file: "hooks/useTauriListener.ts", expr: "event", via: "useTauriListener" },
];

type Source = { rel: string; sf: ts.SourceFile };

/** Resolve an import specifier from `fromRel` to a `src/`-relative path without extension. */
function resolveImport(fromRel: string, spec: string): string | null {
  if (spec.startsWith("@/")) return spec.slice(2);
  if (spec.startsWith("."))
    return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  return null;
}

const stripExt = (rel: string) => rel.replace(/\.(ts|tsx)$/, "");

interface ScanResult {
  sites: ListenSite[];
  /** Forwarding sites (`file|expr`) whose inner `listen` call was found. */
  forwardingSeen: Set<string>;
}

/**
 * Every `listen` / `once` call imported from `@tauri-apps/api/event`, plus every
 * call of a forwarding wrapper (see {@link FORWARDING_SITES}).
 */
function collectListenSites(sources: Source[]): ScanResult {
  const consts = collectStringConsts(sources);
  const sites: ListenSite[] = [];
  const forwardingSeen = new Set<string>();
  for (const { rel, sf } of sources) {
    const names = new Set<string>();
    for (const stmt of sf.statements) {
      if (
        !ts.isImportDeclaration(stmt) ||
        !ts.isStringLiteral(stmt.moduleSpecifier) ||
        !stmt.importClause?.namedBindings ||
        !ts.isNamedImports(stmt.importClause.namedBindings)
      ) {
        continue;
      }
      const spec = stmt.moduleSpecifier.text;
      const target = spec === "@tauri-apps/api/event" ? null : resolveImport(rel, spec);
      for (const el of stmt.importClause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (spec === "@tauri-apps/api/event") {
          if (imported === "listen" || imported === "once") names.add(el.name.text);
        } else if (
          target !== null &&
          FORWARDING_SITES.some((f) => stripExt(f.file) === target && f.via === imported)
        ) {
          names.add(el.name.text);
        }
      }
    }
    if (names.size === 0) continue;
    const forwarding = FORWARDING_SITES.filter((f) => f.file === rel);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        names.has(node.expression.text)
      ) {
        const arg = node.arguments[0];
        const fwd = arg && ts.isIdentifier(arg) && forwarding.find((f) => f.expr === arg.text);
        if (fwd) {
          forwardingSeen.add(`${fwd.file}|${fwd.expr}`);
        } else {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          let name: string | null = null;
          if (arg && ts.isStringLiteralLike(arg)) name = arg.text;
          else if (arg) name = tauriEventValue(arg);
          if (name === null && arg && ts.isIdentifier(arg)) {
            const values = consts.get(arg.text);
            if (values?.size === 1) name = [...values][0];
          }
          sites.push({ where: `src/${rel}:${line}`, name, expr: arg ? arg.getText(sf) : "" });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { sites, forwardingSeen };
}

const emitted = new Set<string>(eventsFixture.emitted);
const { sites, forwardingSeen } = collectListenSites(parseSources());

describe("Tauri event-name contract (TFE2-006, #4344)", () => {
  it("scans a realistic event surface", () => {
    expect(emitted.size).toBeGreaterThan(30);
    expect(sites.length).toBeGreaterThan(30);
  });

  it("resolves the event name of every production listen() call", () => {
    const unresolved = sites.filter((s) => s.name === null).map((s) => `${s.where}: ${s.expr}`);
    expect(unresolved).toEqual([]);
  });

  it("every TAURI_EVENT name is emitted by the backend", () => {
    const missing = Object.entries(TAURI_EVENT)
      .filter(([, name]) => !emitted.has(name))
      .map(([key, name]) => `${key}: ${name}`);
    expect(missing).toEqual([]);
  });

  it("every production listen() name is emitted by the backend", () => {
    const missing = sites
      .filter((s) => s.name !== null && !emitted.has(s.name))
      .map((s) => `${s.where}: ${s.name}`);
    expect(missing).toEqual([]);
  });

  it("every backend-emitted event has a frontend listener (or an allowlisted reason)", () => {
    const listened = new Set(sites.map((s) => s.name));
    const orphans = [...emitted].filter(
      (name) => !listened.has(name) && !(name in EMITTED_WITHOUT_LISTENER)
    );
    expect(orphans).toEqual([]);
  });

  it("keeps the allowlist free of stale entries", () => {
    const listened = new Set(sites.map((s) => s.name));
    const stale = Object.keys(EMITTED_WITHOUT_LISTENER).filter(
      (name) => !emitted.has(name) || listened.has(name)
    );
    expect(stale).toEqual([]);
  });

  it("has no stale FORWARDING_SITES entry", () => {
    const stale = FORWARDING_SITES.filter((f) => !forwardingSeen.has(`${f.file}|${f.expr}`)).map(
      (f) => `${f.file}: listen(${f.expr})`
    );
    expect(stale).toEqual([]);
  });

  it("scans useTauriListener(..) call sites as listen sites", () => {
    const fixture = (rel: string, text: string): Source => ({
      rel,
      sf: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    });
    const scanned = collectListenSites([
      fixture(
        "hooks/useTauriListener.ts",
        'import { listen } from "@tauri-apps/api/event";\n' +
          "export function useTauriListener(event: string) { void listen(event, () => {}); }\n"
      ),
      fixture(
        "components/Probe.tsx",
        'import { useTauriListener as hook } from "@/hooks/useTauriListener";\n' +
          'hook("no-such-backend-event", () => {});\n'
      ),
      fixture(
        "hooks/useProbe.ts",
        'import { useTauriListener } from "./useTauriListener";\n' +
          "useTauriListener(dynamicName, () => {});\n"
      ),
    ]);
    expect(scanned.forwardingSeen).toEqual(new Set(["hooks/useTauriListener.ts|event"]));
    expect(scanned.sites).toEqual([
      {
        where: "src/components/Probe.tsx:2",
        name: "no-such-backend-event",
        expr: '"no-such-backend-event"',
      },
      { where: "src/hooks/useProbe.ts:2", name: null, expr: "dynamicName" },
    ]);
    // The unknown literal is caught by the "emitted by the backend" direction.
    expect(emitted.has("no-such-backend-event")).toBe(false);
  });

  it("no longer listens for or emits the events #4344 removed", () => {
    const listened = new Set(sites.map((s) => s.name));
    for (const removed of [
      "remote-state-change",
      "tunnel-status-changed",
      "tunnel-stats-updated",
      "agent-deploy-progress",
    ]) {
      expect(listened.has(removed)).toBe(false);
      expect(emitted.has(removed)).toBe(false);
    }
  });
});
