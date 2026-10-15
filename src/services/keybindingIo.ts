/**
 * Import/export of keyboard-shortcut overrides as portable JSON files (PROD-055).
 *
 * These are pure helpers: serialising the current keybinding overrides into a
 * small versioned envelope, and validating/parsing such an envelope back into
 * overrides (with zod, #4386). File IO (the save/open dialogs) lives in the UI
 * layer; keeping the serialise/validate logic here makes it unit-testable in
 * isolation and mirrors `services/macroIo.ts` and `themes/themeIO.ts`.
 *
 * The overrides round-trip losslessly through the already-serialized
 * {@link KeybindingOverrideEntry} shape (`{ action, key }`) that the keybindings
 * service persists, so export → import restores exactly the same bindings.
 */

import { z } from "zod";

import type { KeybindingOverrideEntry } from "@/types/keybindings";
import {
  type AssertExact,
  type ImportIssue,
  isRecord,
  nonBlankStringSchema,
  parseImportEnvelope,
} from "@/services/importEnvelope";

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
 * Schema for one override entry of an imported file (#4386). The `key` may be an
 * empty string (the serialized "unbound" sentinel), so only its type is checked,
 * not its emptiness. Unknown keys are stripped.
 */
const importedEntrySchema = z.object({ action: nonBlankStringSchema(), key: z.string() });
/* Drift guard: a new KeybindingOverrideEntry field fails `tsc` until covered here. */
const _entryExact: AssertExact<
  z.output<typeof importedEntrySchema>,
  KeybindingOverrideEntry
> = true;
void _entryExact;

/** Describe an issue inside entry `index` as `<location> <problem>`. */
function describeEntryIssue(
  _issue: ImportIssue,
  raw: unknown,
  index: number,
  path: PropertyKey[]
): string {
  const where = `binding at index ${index}`;
  if (!isRecord(raw)) return `${where} is not an object.`;
  if (path[0] === "action") return `${where} is missing an action.`;
  return `${where} ("${String(raw.action)}") is missing its key.`;
}

/**
 * Parse and validate an exported keyboard-shortcuts file, returning the override
 * entries it contains. Throws an `Error` with a human-readable, recoverable
 * message for malformed JSON, a missing/unsupported envelope version, or any
 * malformed entry — so a bad file never corrupts the current bindings, it just
 * surfaces a toast (the caller applies the result only after this returns).
 */
export function parseKeybindingEnvelope(json: string): KeybindingOverrideEntry[] {
  return parseImportEnvelope(json, {
    label: "keyboard-shortcuts",
    version: KEYBINDING_EXPORT_VERSION,
    listKey: "bindings",
    entry: importedEntrySchema,
    describeEntryIssue,
  });
}
