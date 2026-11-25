/**
 * Validated reading of the `macros` list older builds exported (#1677, #4386).
 * `automationFileIo.ts` turns each entry into an automation that types its keys.
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

/** The version of every file with a `macros` list. */
export const MACRO_EXPORT_VERSION = 1;

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
