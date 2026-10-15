/**
 * Import/export of macros as portable JSON files (#1677).
 *
 * These are pure helpers: serialising a set of macros into a small versioned
 * envelope, validating/parsing an envelope back into macros (with zod, #4386), and
 * resolving id/name collisions when merging imported macros into an existing
 * library. File IO (the save/open dialogs) lives in the UI layer; keeping the
 * serialise/validate/collision logic here makes it unit-testable in isolation.
 */

import { z } from "zod";

import type { Macro } from "@/types/macro";
import {
  type AssertExact,
  type ImportIssue,
  isNonBlankString,
  isRecord,
  nonBlankStringSchema,
  parseImportEnvelope,
} from "@/services/importEnvelope";
import { newId } from "@/services/transport/ids";

/**
 * Current version of the macro export envelope. Bump only on an incompatible
 * change to the on-disk shape; the parser rejects any other version so a newer
 * file fails loudly rather than importing as a corrupt macro.
 */
export const MACRO_EXPORT_VERSION = 1;

/**
 * The stable, explicit on-disk shape for exported macros. A versioned wrapper
 * around the macro list — deliberately NOT the raw internal store — so the file
 * format can evolve independently of the runtime {@link Macro} type.
 */
export interface MacroExportEnvelope {
  /** Envelope schema version; see {@link MACRO_EXPORT_VERSION}. */
  version: number;
  /** The exported macros. */
  macros: Macro[];
}

/** Suffix appended to imported macro names that collide with an existing one. */
const COLLISION_SUFFIX = "imported";

/**
 * Serialise macros into a pretty-printed export envelope string ready to write
 * to a `.json` file. Works for a single macro (`[macro]`) or the whole library.
 */
export function serializeMacros(macros: Macro[]): string {
  const envelope: MacroExportEnvelope = {
    version: MACRO_EXPORT_VERSION,
    macros,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/**
 * Schema for one macro entry of an imported file (#4386). Tolerant of a missing
 * or non-string `description`/`id`/timestamps and of missing `tags` (the
 * importer re-stamps those), but strict about the load-bearing `name`, `steps`
 * and — when present — `tags`. Unknown keys are stripped. Key order is the
 * order errors are reported in.
 */
const importedMacroSchema = z.object({
  name: nonBlankStringSchema(),
  steps: z.array(z.object({ data: z.string(), delayMs: z.number().min(0) })),
  tags: z.array(z.string()).default([]),
  id: z.string().catch(""),
  description: z.string().optional().catch(undefined),
  createdAt: z.string().catch(""),
  updatedAt: z.string().catch(""),
});
/* Drift guard: a new Macro / MacroStep field fails `tsc` until the schema covers it. */
const _macroExact: AssertExact<z.output<typeof importedMacroSchema>, Macro> = true;
void _macroExact;

/**
 * Describe an issue inside macro `index` as `<location> <problem>`, naming the
 * macro by index and — once its name is valid — by name.
 */
function describeMacroIssue(
  _issue: ImportIssue,
  raw: unknown,
  index: number,
  path: PropertyKey[]
): string {
  const where = `macro at index ${index}`;
  if (!isRecord(raw)) return `${where} is not an object.`;
  const label = isNonBlankString(raw.name) ? `${where} ("${raw.name}")` : where;
  const [field, step, stepField] = path;
  switch (field) {
    case "name":
      return `${where} is missing a name.`;
    case "steps":
      if (typeof step !== "number") return `${label} is missing its steps.`;
      return stepField === "delayMs"
        ? `step ${step} of ${label} has an invalid delay.`
        : `step ${step} of ${label} is malformed.`;
    case "tags":
      return `${label} has malformed tags.`;
    default:
      return `${label} is malformed.`;
  }
}

/**
 * Parse and validate an exported-macro file, returning the macros it contains.
 * Throws an `Error` with a human-readable, recoverable message for malformed
 * JSON, a missing/unsupported envelope version, or any malformed macro — so a
 * bad file never corrupts the library, it just surfaces a toast.
 */
export function parseMacroEnvelope(json: string): Macro[] {
  const macros = parseImportEnvelope(json, {
    label: "macro",
    version: MACRO_EXPORT_VERSION,
    listKey: "macros",
    entry: importedMacroSchema,
    describeEntryIssue: describeMacroIssue,
  });
  // Normalise to the stable key order.
  return macros.map(({ id, name, description, tags, steps, createdAt, updatedAt }) => ({
    id,
    name,
    description,
    tags,
    steps,
    createdAt,
    updatedAt,
  }));
}

/** Default fresh-id generator; mirrors the store's `generateMacroId`. */
function defaultGenerateId(): string {
  return newId("macro");
}

/**
 * Given a desired name and the set of names already in use, return a unique name
 * by appending "(imported)", then "(imported 2)", "(imported 3)", … until it no
 * longer collides. Leaves the name untouched when there is no collision.
 */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  let candidate = `${name} (${COLLISION_SUFFIX})`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${name} (${COLLISION_SUFFIX} ${n})`;
    n += 1;
  }
  return candidate;
}

/**
 * Prepare imported macros for merging into an existing library. Every imported
 * macro is given a **fresh id** (so it never overwrites an existing macro, even
 * when the file was exported from this same instance), has its create/update
 * timestamps cleared (the backend re-stamps them on save), and gets a
 * **deterministically de-duplicated name** — a name that already exists (in the
 * library or earlier in this same batch) is suffixed with "(imported)".
 *
 * @param imported Macros parsed from a file (see {@link parseMacroEnvelope}).
 * @param existing The current library, used for name-collision detection.
 * @param generateId Injectable id generator (defaults to a crypto-based uuid).
 */
export function resolveImportCollisions(
  imported: Macro[],
  existing: Macro[],
  generateId: () => string = defaultGenerateId
): Macro[] {
  const usedNames = new Set(existing.map((m) => m.name));
  return imported.map((macro) => {
    const name = uniqueName(macro.name, usedNames);
    usedNames.add(name);
    return {
      ...macro,
      id: generateId(),
      name,
      // Cleared so the backend stamps authoritative timestamps on save.
      createdAt: "",
      updatedAt: "",
    };
  });
}
