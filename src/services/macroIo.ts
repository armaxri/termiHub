/**
 * Import/export of macros as portable JSON files (#1677).
 *
 * These are pure, dependency-free helpers: serialising a set of macros into a
 * small versioned envelope, validating/parsing an envelope back into macros, and
 * resolving id/name collisions when merging imported macros into an existing
 * library. File IO (the save/open dialogs) lives in the UI layer; keeping the
 * serialise/validate/collision logic here makes it unit-testable in isolation.
 */

import type { Macro, MacroStep } from "@/types/macro";

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

/** Type guard: a JSON value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one raw macro entry from an imported file, throwing a clear error
 * that names the offending macro (by index) when a field is missing or the
 * wrong type. Returns a normalised {@link Macro} — tolerant of a missing
 * `description`/`tags`/`id`/timestamps since the importer re-stamps those, but
 * strict about the load-bearing `name` and `steps`.
 */
function validateMacro(raw: unknown, index: number): Macro {
  const where = `macro at index ${index}`;
  if (!isRecord(raw)) {
    throw new Error(`Invalid macro file: ${where} is not an object.`);
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new Error(`Invalid macro file: ${where} is missing a name.`);
  }
  if (!Array.isArray(raw.steps)) {
    throw new Error(`Invalid macro file: ${where} ("${raw.name}") is missing its steps.`);
  }

  const steps: MacroStep[] = raw.steps.map((step, stepIndex) => {
    if (!isRecord(step) || typeof step.data !== "string") {
      throw new Error(
        `Invalid macro file: step ${stepIndex} of ${where} ("${raw.name}") is malformed.`
      );
    }
    const delayMs = step.delayMs;
    if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(
        `Invalid macro file: step ${stepIndex} of ${where} ("${raw.name}") has an invalid delay.`
      );
    }
    return { data: step.data, delayMs };
  });

  let tags: string[] = [];
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string")) {
      throw new Error(`Invalid macro file: ${where} ("${raw.name}") has malformed tags.`);
    }
    tags = raw.tags as string[];
  }

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : undefined,
    tags,
    steps,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/**
 * Parse and validate an exported-macro file, returning the macros it contains.
 * Throws an `Error` with a human-readable, recoverable message for malformed
 * JSON, a missing/unsupported envelope version, or any malformed macro — so a
 * bad file never corrupts the library, it just surfaces a toast.
 */
export function parseMacroEnvelope(json: string): Macro[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid macro file: the file is not valid JSON.");
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid macro file: expected a macro export object.");
  }
  if (parsed.version !== MACRO_EXPORT_VERSION) {
    throw new Error(
      `Unsupported macro file version: ${String(parsed.version)} (expected ${MACRO_EXPORT_VERSION}).`
    );
  }
  if (!Array.isArray(parsed.macros)) {
    throw new Error('Invalid macro file: missing "macros" array.');
  }

  return parsed.macros.map((macro, index) => validateMacro(macro, index));
}

/** Default fresh-id generator; mirrors the store's `generateMacroId`. */
function defaultGenerateId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return `macro-${c.randomUUID()}`;
  }
  return `macro-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
