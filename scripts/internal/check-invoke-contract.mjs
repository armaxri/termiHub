#!/usr/bin/env node
// Frontend <-> backend IPC argument contract check (#3488).
//
// Tauri matches `invoke("cmd", { ... })` arguments to a `#[tauri::command]`
// function's parameters BY NAME (the snake_case Rust parameter converted to
// lowerCamelCase). A wrong key is not a type error on either side: it only
// surfaces at runtime as "missing required key", and a unit test that mocks
// `invoke` happily locks the wrong key in (#3488: enable/disable/uninstall
// plugin sent `pluginId` to commands taking `id`).
//
// This check statically cross-references both sides:
//
//   Rust: every `#[tauri::command]` fn under src-tauri/src/, restricted to the
//         ones registered in `tauri::generate_handler![...]` (src-tauri/src/lib.rs).
//         Parameters Tauri injects itself (State, AppHandle, Window,
//         WebviewWindow, Webview, Request, ...) are skipped; `Option<T>`
//         parameters are optional; everything else is required.
//   TS:   every call of `invoke` imported from `@tauri-apps/api/core` in
//         src/**/*.{ts,tsx} (tests excluded), parsed with the TypeScript
//         compiler API.
//
// It fails on: an unknown / unregistered command name, a missing required
// argument, an unknown extra argument, and a call it cannot verify (non-literal
// command name, or an args expression that is not an object literal). Spread
// elements (`{ ...rest }`) make the key set open-ended: extra-key checking
// still applies to the literal keys, but missing-key checking is skipped.
//
// Usage: node scripts/internal/check-invoke-contract.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-invoke-contract.test.mjs).

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import ts from "typescript";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Parameter types Tauri resolves itself (never sent by the frontend). Matched
 * against the last path segment of the type, ignoring generic arguments.
 */
export const INJECTED_TYPES = new Set([
  "State",
  "AppHandle",
  "Window",
  "WebviewWindow",
  "Webview",
  "Request",
  "InvokeMessage",
  "CommandScope",
  "GlobalScope",
]);

/**
 * Convert a Rust parameter name to the invoke key Tauri expects (heck's
 * lowerCamelCase, the default `rename_all = "camelCase"` of `#[tauri::command]`).
 *
 * @param {string} name - snake_case Rust identifier.
 * @returns {string} lowerCamelCase key.
 */
export function toCamelCase(name) {
  const words = name
    .replace(/^r#/, "")
    .split("_")
    .filter((w) => w.length > 0);
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
}

/** Replace Rust comments and string/char literal contents with spaces (offsets preserved). */
export function stripRustComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && n === "*") {
      let depth = 0;
      do {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          out += "  ";
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          out += "  ";
          i += 2;
        } else {
          out += src[i] === "\n" ? "\n" : " ";
          i++;
        }
      } while (i < src.length && depth > 0);
    } else if (c === "'" && /^'(\\.[^']*|[^\\'\n])'/.test(src.slice(i, i + 12))) {
      // Char literal (e.g. '"'); lifetimes like 'a have no closing quote.
      const len = src.slice(i).match(/^'(\\.[^']*|[^\\'\n])'/)[0].length;
      out += " ".repeat(len);
      i += len;
    } else if (c === "r" && /^r#*"/.test(src.slice(i, i + 12)) && !/\w/.test(src[i - 1] ?? "")) {
      // Raw string r"..." / r#"..."#.
      const hashes = src.slice(i).match(/^r(#*)"/)[1];
      const close = src.indexOf(`"${hashes}`, i + 2 + hashes.length);
      const stop = close === -1 ? src.length : close + 1 + hashes.length;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"') {
      out += '"';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
        } else {
          out += src[i] === "\n" ? "\n" : " ";
          i++;
        }
      }
      out += '"';
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Split `text` on commas that are not nested inside (), <>, [] or {}. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("(<[{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    // `->` inside a type (e.g. `impl Fn() -> T`) is not a closing angle bracket.
    else if (c === ">" && text[i - 1] !== "-") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Return the index just past the bracket group opened at `start`. */
function skipBalanced(src, start, open, close) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && !(close === ">" && src[i - 1] === "-")) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/**
 * Classify one Rust parameter type.
 *
 * @param {string} type - the type text after the colon.
 * @returns {"injected" | "optional" | "required"}
 */
export function classifyType(type) {
  const base = type
    .trim()
    .replace(/^&\s*('\w+\s+)?(mut\s+)?/, "")
    .replace(/<[\s\S]*$/, "")
    .trim();
  const last = base.split("::").pop();
  if (INJECTED_TYPES.has(last)) return "injected";
  if (last === "Option") return "optional";
  return "required";
}

/**
 * Parse every `#[tauri::command]` function in one Rust source file.
 *
 * @param {string} source - Rust source text.
 * @returns {{name: string, renameAll: string | null,
 *   params: {rust: string, key: string, kind: "optional" | "required"}[]}[]}
 */
export function parseRustCommands(source) {
  const src = stripRustComments(source);
  const commands = [];
  const attrRe = /#\[\s*tauri::command\s*(\(([^)]*)\))?\s*\]/g;
  let m;
  while ((m = attrRe.exec(src)) !== null) {
    // String contents are blanked in `src`; read the attribute args from the original.
    const attrArgs = source.slice(m.index, m.index + m[0].length);
    const renameMatch = attrArgs.match(/rename_all\s*=\s*"(\w+)"/);
    const renameAll = renameMatch ? renameMatch[1] : null;
    const fnRe = /\bfn\s+(r#)?(\w+)\s*/y;
    // Skip further attributes / visibility / qualifiers up to `fn`.
    const fnIdx = src.slice(attrRe.lastIndex).search(/\bfn\s+/);
    if (fnIdx === -1) continue;
    fnRe.lastIndex = attrRe.lastIndex + fnIdx;
    const fm = fnRe.exec(src);
    if (!fm) continue;
    const name = fm[2];
    let i = fnRe.lastIndex;
    if (src[i] === "<") i = skipBalanced(src, i, "<", ">");
    while (/\s/.test(src[i])) i++;
    if (src[i] !== "(") continue;
    const end = skipBalanced(src, i, "(", ")");
    const paramText = src.slice(i + 1, end - 1);
    const params = [];
    for (const part of splitTopLevel(paramText)) {
      const colon = part.search(/:(?!:)/);
      if (colon === -1) continue; // `self` receivers — not a command param.
      const pattern = part
        .slice(0, colon)
        .replace(/#\[[^\]]*\]/g, "")
        .trim()
        .replace(/^mut\s+/, "");
      const type = part.slice(colon + 1);
      const kind = classifyType(type);
      if (kind === "injected") continue;
      const rust = pattern.replace(/^r#/, "");
      const key = renameAll === "snake_case" ? rust.replace(/^_+/, "") : toCamelCase(rust);
      params.push({ rust, key, kind });
    }
    commands.push({ name, renameAll, params });
    attrRe.lastIndex = end;
  }
  return commands;
}

/**
 * Parse the command paths listed in `tauri::generate_handler![...]`.
 *
 * @param {string} libSource - src-tauri/src/lib.rs text.
 * @returns {string[]} registered paths, e.g. `commands::plugin::enable_plugin`.
 */
export function parseRegisteredCommands(libSource) {
  const src = stripRustComments(libSource);
  const start = src.search(/generate_handler!\s*\[/);
  if (start === -1) return [];
  const open = src.indexOf("[", start);
  const end = skipBalanced(src, open, "[", "]");
  return splitTopLevel(src.slice(open + 1, end - 1).replace(/#\[[^\]]*\]/g, ""))
    .map((p) => p.replace(/\s+/g, ""))
    .filter((p) => /^[\w:]+$/.test(p));
}

/** Module path of a Rust file relative to `src-tauri/src` (`commands/plugin.rs` → `commands::plugin`). */
export function modulePathOf(relFile) {
  const parts = relFile.replace(/\\/g, "/").replace(/\.rs$/, "").split("/");
  if (parts[parts.length - 1] === "mod" || parts[parts.length - 1] === "lib") parts.pop();
  return parts.join("::");
}

/**
 * Build the command contract: registered command name → its frontend params.
 *
 * @param {Record<string, string>} rustFiles - path relative to src-tauri/src → source.
 * @param {string} libSource - src-tauri/src/lib.rs text.
 * @returns {{contract: Map<string, ReturnType<typeof parseRustCommands>[number]>,
 *   problems: string[]}}
 */
export function buildContract(rustFiles, libSource) {
  const byPath = new Map();
  const byName = new Map();
  for (const [rel, source] of Object.entries(rustFiles)) {
    const mod = modulePathOf(rel);
    for (const cmd of parseRustCommands(source)) {
      byPath.set(mod ? `${mod}::${cmd.name}` : cmd.name, cmd);
      if (!byName.has(cmd.name)) byName.set(cmd.name, []);
      byName.get(cmd.name).push(cmd);
    }
  }
  const contract = new Map();
  const problems = [];
  for (const reg of parseRegisteredCommands(libSource)) {
    const name = reg.split("::").pop();
    let cmd = byPath.get(reg.replace(/^crate::/, ""));
    if (!cmd && byName.get(name)?.length === 1) cmd = byName.get(name)[0];
    if (!cmd) {
      problems.push(`registered command '${reg}' has no parseable #[tauri::command] fn`);
      continue;
    }
    contract.set(name, cmd);
  }
  return { contract, problems };
}

/**
 * Collect every `invoke(...)` call (from `@tauri-apps/api/core`) in one TS file.
 *
 * @param {string} source - TS/TSX source text.
 * @param {string} fileName - used for locations and TSX detection.
 * @returns {{file: string, line: number, command: string | null,
 *   keys: string[] | null, open: boolean, reason?: string}[]}
 */
export function collectInvokeCalls(source, fileName) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const invokeNames = new Set();
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === "@tauri-apps/api/core" &&
      stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      for (const el of stmt.importClause.namedBindings.elements) {
        if ((el.propertyName ?? el.name).text === "invoke") invokeNames.add(el.name.text);
      }
    }
  }
  const calls = [];
  if (invokeNames.size === 0) return calls;

  /** Resolve an identifier to a same-file `const x = { ... }` initializer. */
  const constInitializers = new Map();
  const collectConsts = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    ) {
      constInitializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectConsts);
  };
  collectConsts(sf);

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      invokeNames.has(node.expression.text)
    ) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const [cmdArg, argsArg] = node.arguments;
      const call = { file: fileName, line, command: null, keys: [], open: false };
      if (cmdArg && (ts.isStringLiteral(cmdArg) || ts.isNoSubstitutionTemplateLiteral(cmdArg))) {
        call.command = cmdArg.text;
      } else {
        call.reason = "command name is not a string literal";
      }
      let args = argsArg;
      while (args && (ts.isAsExpression(args) || ts.isSatisfiesExpression?.(args))) {
        args = args.expression;
      }
      if (args && ts.isIdentifier(args) && constInitializers.has(args.text)) {
        args = constInitializers.get(args.text);
      }
      if (!args) {
        call.keys = [];
      } else if (ts.isObjectLiteralExpression(args)) {
        for (const prop of args.properties) {
          if (ts.isSpreadAssignment(prop)) {
            call.open = true;
          } else if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
            call.keys.push(prop.name.text);
          } else {
            call.open = true;
          }
        }
      } else {
        call.keys = null;
        call.reason = call.reason ?? "args are not an object literal";
      }
      calls.push(call);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

/**
 * Compare every invoke call against the contract.
 *
 * @returns {string[]} human-readable problems (empty = contract holds).
 */
export function findMismatches(contract, calls) {
  const problems = [];
  for (const call of calls) {
    const where = `${call.file}:${call.line}`;
    if (call.command === null || call.keys === null) {
      problems.push(`${where}: cannot verify invoke(${call.command ?? "?"}) — ${call.reason}`);
      continue;
    }
    const cmd = contract.get(call.command);
    if (!cmd) {
      problems.push(`${where}: invoke("${call.command}") — no such registered Tauri command`);
      continue;
    }
    const known = new Set(cmd.params.map((p) => p.key));
    for (const key of call.keys) {
      if (!known.has(key)) {
        const expected = cmd.params.map((p) => p.key).join(", ") || "(none)";
        problems.push(
          `${where}: invoke("${call.command}") passes unknown arg '${key}' (expects: ${expected})`
        );
      }
    }
    if (!call.open) {
      const passed = new Set(call.keys);
      for (const p of cmd.params) {
        if (p.kind === "required" && !passed.has(p.key)) {
          problems.push(
            `${where}: invoke("${call.command}") is missing required arg '${p.key}' (Rust '${p.rust}')`
          );
        }
      }
    }
  }
  return problems;
}

/** Recursively list files under `dir` whose name matches `pred`. */
function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "target") continue;
      walk(full, pred, out);
    } else if (pred(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Whether a frontend file is production code (tests / test setup excluded). */
export function isProductionTsFile(rel) {
  const p = rel.replace(/\\/g, "/");
  if (!/\.(ts|tsx)$/.test(p) || p.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\.tsx?$/.test(p)) return false;
  if (p.startsWith("src/test/") || p.includes("/__tests__/") || p.includes("/__mocks__/")) {
    return false;
  }
  return true;
}

/** Run the whole-repo check. */
export function checkRepo(root) {
  const rustRoot = path.join(root, "src-tauri", "src");
  const rustFiles = {};
  for (const f of walk(rustRoot, (p) => p.endsWith(".rs"))) {
    const text = readFileSync(f, "utf8");
    if (text.includes("tauri::command")) rustFiles[path.relative(rustRoot, f)] = text;
  }
  const libSource = readFileSync(path.join(rustRoot, "lib.rs"), "utf8");
  const { contract, problems } = buildContract(rustFiles, libSource);
  const calls = [];
  for (const f of walk(path.join(root, "src"), () => true)) {
    const rel = path.relative(root, f).replace(/\\/g, "/");
    if (!isProductionTsFile(rel)) continue;
    calls.push(...collectInvokeCalls(readFileSync(f, "utf8"), rel));
  }
  return { contract, calls, problems: [...problems, ...findMismatches(contract, calls)] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootIdx = process.argv.indexOf("--root");
  const root = rootIdx !== -1 ? path.resolve(process.argv[rootIdx + 1]) : DEFAULT_ROOT;
  const { contract, calls, problems } = checkRepo(root);
  if (problems.length > 0) {
    console.error(`IPC invoke contract: ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "Tauri matches invoke args by name: the key must be the lowerCamelCase of the Rust " +
        "#[tauri::command] parameter. See scripts/internal/check-invoke-contract.mjs."
    );
    process.exit(1);
  }
  console.log(
    `IPC invoke contract OK: ${calls.length} invoke call(s) against ${contract.size} registered command(s).`
  );
}
