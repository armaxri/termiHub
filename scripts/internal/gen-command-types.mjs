#!/usr/bin/env node
// Generate the typed IPC command map for tests (#6151).
//
// The frontend reaches the backend through `invoke("command", args)` from
// `@tauri-apps/api/core`. Tests used to mock `invoke` with string-matched
// branches (`if (cmd === "local_stat") …`): a renamed command or a changed
// argument or result type kept those tests green while the app broke.
//
// This script reads every production `invoke` call with the TypeScript type
// checker and writes `src/types/commands.generated.ts`: one `Commands` entry
// per command name with the argument type the frontend sends (`args`) and the
// result type it reads (`result`, the call's `invoke<T>` type argument). The
// test helper `src/test/fakeBackend.ts` is keyed by it, so a test's handler for
// a command that was renamed or retyped no longer compiles.
//
// A command invoked from several places gets the union of their types. A type
// the generated file cannot name (not exported from its module) becomes
// `unknown`.
//
// Usage:
//   node scripts/internal/gen-command-types.mjs           # rewrite the file
//   node scripts/internal/gen-command-types.mjs --check   # exit 1 when stale

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript";
import { isMainModule } from "./is-main-module.mjs";
import { isProductionTsFile } from "./check-invoke-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The generated file, relative to the repository root. */
export const OUTPUT = "src/types/commands.generated.ts";
const INVOKE_MODULE = "@tauri-apps/api/core";
const MAX_DEPTH = 8;

/** Every production `.ts`/`.tsx` file under `src/` that imports from the invoke module. */
export function invokeFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (!isProductionTsFile(rel)) continue;
      if (readFileSync(full, "utf8").includes(INVOKE_MODULE)) out.push(full);
    }
  };
  walk(path.join(root, "src"));
  return out.sort();
}

/** The local names `invoke` is imported under in `sf`. */
function invokeNames(sf) {
  const names = new Set();
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === INVOKE_MODULE &&
      stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      for (const el of stmt.importClause.namedBindings.elements) {
        if ((el.propertyName ?? el.name).text === "invoke") names.add(el.name.text);
      }
    }
  }
  return names;
}

/** Prints checker types as source text, collecting the imports they need. */
class TypePrinter {
  constructor(checker, root) {
    this.checker = checker;
    this.srcDir = path.join(root, "src");
    /** module specifier -> Map(exported name -> local name) */
    this.imports = new Map();
    /** local name -> symbol, to keep two same-named types apart */
    this.localNames = new Map();
  }

  /** A name for `symbol` usable in the generated file, or null when it has none. */
  nameOf(symbol) {
    const decl = symbol.declarations?.[0];
    if (!decl) return null;
    const sf = decl.getSourceFile();
    const file = sf.fileName;
    // A global type from TypeScript's own lib files (Date, Uint8Array, Record).
    if (sf.isDeclarationFile && /[\\/]typescript[\\/]lib[\\/]/.test(file)) return symbol.name;
    if (!file.startsWith(this.srcDir + path.sep) && !file.startsWith(this.srcDir + "/")) {
      return null;
    }
    const moduleSymbol = this.checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) return null;
    const exported = this.checker.getExportsOfModule(moduleSymbol).find((e) => {
      const target = e.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(e) : e;
      return target === symbol;
    });
    if (!exported) return null;
    const rel = path.relative(this.srcDir, file).split(path.sep).join("/");
    const specifier = "@/" + rel.replace(/\.tsx?$/, "");
    const names = this.imports.get(specifier) ?? new Map();
    this.imports.set(specifier, names);
    if (names.has(exported.name)) return names.get(exported.name);
    let local = exported.name;
    for (let n = 2; this.localNames.has(local) && this.localNames.get(local) !== symbol; n++) {
      local = `${exported.name}_${n}`;
    }
    this.localNames.set(local, symbol);
    names.set(exported.name, local);
    return local;
  }

  /** The type arguments of a generic reference, printed, or "". */
  typeArgs(args, depth) {
    if (!args || args.length === 0) return "";
    return `<${args.map((a) => this.print(a, depth + 1)).join(", ")}>`;
  }

  print(type, depth = 0) {
    const c = this.checker;
    if (depth > MAX_DEPTH) return "unknown";
    const f = type.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "unknown";
    if (type.aliasSymbol) {
      const name = this.nameOf(type.aliasSymbol);
      if (name) return name + this.typeArgs(type.aliasTypeArguments, depth);
    }
    if (type.isUnion()) {
      let members = type.types.map((t) => this.print(t, depth + 1));
      if (members.includes("true") && members.includes("false")) {
        members = members.filter((m) => m !== "true" && m !== "false");
        members.push("boolean");
      }
      return [...new Set(members)].join(" | ");
    }
    if (type.isIntersection()) {
      return type.types.map((t) => this.wrap(this.print(t, depth + 1))).join(" & ");
    }
    if (
      f &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void |
        ts.TypeFlags.Never)
    ) {
      if (f & ts.TypeFlags.EnumLike && type.symbol) {
        const name = this.nameOf(type.symbol);
        if (name) return name;
      }
      return c.typeToString(type);
    }
    if (c.isArrayType(type)) {
      return `Array<${this.print(c.getTypeArguments(type)[0], depth + 1)}>`;
    }
    if (c.isTupleType(type)) {
      return `[${c
        .getTypeArguments(type)
        .map((t) => this.print(t, depth + 1))
        .join(", ")}]`;
    }
    if (f & ts.TypeFlags.Object) {
      const symbol = type.symbol;
      const named =
        symbol &&
        symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum);
      if (named) {
        const name = this.nameOf(symbol);
        if (!name) return "unknown";
        const args = type.objectFlags & ts.ObjectFlags.Reference ? c.getTypeArguments(type) : [];
        return name + this.typeArgs(args, depth);
      }
      if (c.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) return "unknown";
      return this.literal(type, depth);
    }
    return "unknown";
  }

  /** An anonymous object type as a type literal. */
  literal(type, depth) {
    const c = this.checker;
    const parts = [];
    for (const info of c.getIndexInfosOfType(type)) {
      parts.push(`[key: ${c.typeToString(info.keyType)}]: ${this.print(info.type, depth + 1)}`);
    }
    for (const prop of c.getPropertiesOfType(type)) {
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      const propType = decl ? c.getTypeOfSymbolAtLocation(prop, decl) : c.getTypeOfSymbol(prop);
      const optional = prop.flags & ts.SymbolFlags.Optional ? "?" : "";
      const key = /^[A-Za-z_$][\w$]*$/.test(prop.name) ? prop.name : JSON.stringify(prop.name);
      parts.push(`${key}${optional}: ${this.print(propType, depth + 1)}`);
    }
    return parts.length === 0 ? "Record<string, never>" : `{ ${parts.join("; ")} }`;
  }

  /** Parenthesizes a union inside an intersection. */
  wrap(text) {
    return text.includes(" | ") ? `(${text})` : text;
  }

  /** The import lines the printed types need, sorted. */
  importLines() {
    return [...this.imports.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([specifier, names]) => {
        const items = [...names.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, local]) => (name === local ? name : `${name} as ${local}`));
        return `import type { ${items.join(", ")} } from "${specifier}";`;
      });
  }
}

/** Read the tsconfig compiler options of `root`. */
function compilerOptions(root) {
  const configPath = path.join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
}

/**
 * Collect every production invoke call's command, argument type and result type.
 *
 * @returns {Map<string, {args: Set<string>, result: Set<string>}>} plus the printer
 */
export function collectCommands(root, files = invokeFiles(root)) {
  const program = ts.createProgram(files, { ...compilerOptions(root), noEmit: true });
  const checker = program.getTypeChecker();
  const printer = new TypePrinter(checker, root);
  const commands = new Map();
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const names = invokeNames(sf);
    if (names.size === 0) continue;
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        names.has(node.expression.text)
      ) {
        const [cmdArg, argsArg] = node.arguments;
        if (cmdArg && (ts.isStringLiteral(cmdArg) || ts.isNoSubstitutionTemplateLiteral(cmdArg))) {
          const entry = commands.get(cmdArg.text) ?? { args: new Set(), result: new Set() };
          commands.set(cmdArg.text, entry);
          entry.args.add(
            argsArg
              ? printer.print(checker.getWidenedType(checker.getTypeAtLocation(argsArg)))
              : "undefined"
          );
          const typeArg = node.typeArguments?.[0];
          entry.result.add(
            typeArg ? printer.print(checker.getTypeFromTypeNode(typeArg)) : "unknown"
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { commands, printer };
}

/** A set of printed types as one type: their union, or `unknown` if one is. */
function union(types) {
  const all = [...types];
  if (all.includes("unknown")) return "unknown";
  return all.join(" | ");
}

/** The generated file's text (unformatted). */
export function render(root, collected = collectCommands(root)) {
  const { commands, printer } = collected;
  const entries = [...commands.entries()].sort(([a], [b]) => a.localeCompare(b));
  const body = entries
    .map(
      ([name, { args, result }]) => `  ${name}: { args: ${union(args)}; result: ${union(result)} };`
    )
    .join("\n");
  return [
    "// Generated by scripts/internal/gen-command-types.mjs (#6151). Do not edit.",
    "// Run `node scripts/internal/gen-command-types.mjs` after changing an invoke call.",
    "",
    ...printer.importLines(),
    "",
    "/**",
    " * Every backend command the frontend invokes: the argument type it sends and",
    " * the result type it reads. `src/test/fakeBackend.ts` is keyed by it.",
    " */",
    "export interface Commands {",
    body,
    "}",
    "",
    "/** The name of a backend command the frontend invokes. */",
    "export type CommandName = keyof Commands;",
    "",
  ].join("\n");
}

/** The generated file's text, formatted like the rest of the repo. */
export async function generate(root = ROOT) {
  const prettier = await import("prettier");
  const target = path.join(root, OUTPUT);
  const options = (await prettier.resolveConfig(target)) ?? {};
  return prettier.format(render(root), { ...options, filepath: target });
}

async function main() {
  const check = process.argv.includes("--check");
  const target = path.join(ROOT, OUTPUT);
  const text = await generate(ROOT);
  if (check) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current !== text) {
      console.error(`${OUTPUT} is stale. Run: node scripts/internal/gen-command-types.mjs`);
      process.exit(1);
    }
    console.log(`${OUTPUT} is up to date.`);
    return;
  }
  writeFileSync(target, text);
  console.log(`wrote ${OUTPUT}`);
}

if (isMainModule(import.meta.url)) await main();
