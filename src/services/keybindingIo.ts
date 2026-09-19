/**
 * Import/export of keyboard-shortcut overrides as portable JSON files (PROD-055).
 *
 * These are pure, dependency-free helpers: serialising the current keybinding
 * overrides into a small versioned envelope, and validating/parsing such an
 * envelope back into overrides. File IO (the save/open dialogs) lives in the UI
 * layer; keeping the serialise/validate logic here makes it unit-testable in
 * isolation and mirrors `services/macroIo.ts` and `themes/themeIO.ts`.
 *
 * The overrides round-trip losslessly through the already-serialized
 * {@link KeybindingOverrideEntry} shape (`{ action, key }`) that the keybindings
 * service persists, so export → import restores exactly the same bindings.
 */

import type { KeybindingOverrideEntry } from "@/types/keybindings";

/**
 * Current version of the keybinding export envelope. Bump only on an
 * incompatible change to the on-disk shape; the parser rejects any other version
 * so a newer file fails loudly rather than importing as corrupt bindings.
 */
export const KEYBINDING_EXPORT_VERSION = 1;

/**
 * The stable, explicit on-disk shape for exported keyboard shortcuts. A versioned
 * wrapper around the override list — deliberately NOT the raw runtime state — so
 * the file format can evolve independently of the internal types.
 */
export interface KeybindingExportEnvelope {
  /** Envelope schema version; see {@link KEYBINDING_EXPORT_VERSION}. */
  version: number;
  /** The exported keybinding overrides, in serialized `{ action, key }` form. */
  bindings: KeybindingOverrideEntry[];
}

/** Type guard: a JSON value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialise keybinding overrides into a pretty-printed export envelope string
 * ready to write to a `.json` file.
 */
export function serializeKeybindings(entries: KeybindingOverrideEntry[]): string {
  const envelope: KeybindingExportEnvelope = {
    version: KEYBINDING_EXPORT_VERSION,
    bindings: entries,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/**
 * Validate one raw override entry from an imported file, throwing a clear error
 * that names the offending entry (by index) when a field is missing or the wrong
 * type. The `key` may be an empty string (the serialized "unbound" sentinel), so
 * only its type is checked, not its emptiness.
 */
function validateEntry(raw: unknown, index: number): KeybindingOverrideEntry {
  const where = `binding at index ${index}`;
  if (!isRecord(raw)) {
    throw new Error(`Invalid keyboard-shortcuts file: ${where} is not an object.`);
  }
  if (typeof raw.action !== "string" || raw.action.trim() === "") {
    throw new Error(`Invalid keyboard-shortcuts file: ${where} is missing an action.`);
  }
  if (typeof raw.key !== "string") {
    throw new Error(
      `Invalid keyboard-shortcuts file: ${where} ("${raw.action}") is missing its key.`
    );
  }
  return { action: raw.action, key: raw.key };
}

/**
 * Parse and validate an exported keyboard-shortcuts file, returning the override
 * entries it contains. Throws an `Error` with a human-readable, recoverable
 * message for malformed JSON, a missing/unsupported envelope version, or any
 * malformed entry — so a bad file never corrupts the current bindings, it just
 * surfaces a toast (the caller applies the result only after this returns).
 */
export function parseKeybindingEnvelope(json: string): KeybindingOverrideEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid keyboard-shortcuts file: the file is not valid JSON.");
  }

  if (!isRecord(parsed)) {
    throw new Error(
      "Invalid keyboard-shortcuts file: expected a keyboard-shortcuts export object."
    );
  }
  if (parsed.version !== KEYBINDING_EXPORT_VERSION) {
    throw new Error(
      `Unsupported keyboard-shortcuts file version: ${String(parsed.version)} ` +
        `(expected ${KEYBINDING_EXPORT_VERSION}).`
    );
  }
  if (!Array.isArray(parsed.bindings)) {
    throw new Error('Invalid keyboard-shortcuts file: missing "bindings" array.');
  }

  return parsed.bindings.map((entry, index) => validateEntry(entry, index));
}
