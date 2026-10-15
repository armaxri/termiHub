/**
 * Shared parsing for versioned import files (#4386, LIBFE2-007).
 *
 * Workflow, macro and keyboard-shortcut exports all share one envelope shape —
 * `{ version, <list>: [...] }` — and one set of envelope-level error messages.
 * {@link parseImportEnvelope} validates that envelope and every entry with zod,
 * then turns the **first** zod issue into a single human-readable error via the
 * caller's {@link EnvelopeSpec.describeEntryIssue}, so a bad file is rejected
 * with a precise message instead of a raw zod dump.
 */
import { z } from "zod";

/** A zod issue, as reported by `safeParse`. */
export type ImportIssue = z.core.$ZodIssue;

/** `true` only when `A` and `B` are the identical type (not merely assignable). */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Compiles only when the two types are identical. Used as
 * `const _x: AssertExact<z.output<typeof schema>, DomainType> = true` so a
 * schema whose output drifts from the generated domain type — for example a new
 * optional field the schema does not cover — is a `tsc` error rather than a
 * field silently dropped on import.
 */
export type AssertExact<A, B> = Exact<A, B> extends true ? true : never;

/** Type guard: a JSON value is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `true` for a string with at least one non-whitespace character. */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Schema for a name-like string: at least one non-whitespace character. */
export const nonBlankStringSchema = () => z.string().refine((s) => s.trim() !== "");

/** Read `obj[key]` from an untrusted JSON value, or `undefined` when absent. */
export function child(value: unknown, key: PropertyKey): unknown {
  if (Array.isArray(value) && typeof key === "number") return value[key];
  if (isRecord(value) && typeof key === "string") return value[key];
  return undefined;
}

/** How to parse one kind of versioned import file. */
export interface EnvelopeSpec<T> {
  /** File label used in messages: `Invalid <label> file: …`. */
  label: string;
  /** The only accepted envelope `version`. */
  version: number;
  /** The envelope key that holds the entry list (e.g. `"workflows"`). */
  listKey: string;
  /** Schema for one entry. */
  entry: z.ZodType<T>;
  /**
   * Describe an issue inside one entry as `<location> <problem>` (the caller
   * prefixes `Invalid <label> file: `).
   *
   * @param issue The zod issue (its `code`/`message` for custom refinements).
   * @param raw The raw, untrusted entry value.
   * @param index The entry's index in the list.
   * @param path The issue path relative to the entry.
   */
  describeEntryIssue: (
    issue: ImportIssue,
    raw: unknown,
    index: number,
    path: PropertyKey[]
  ) => string;
}

/**
 * Parse and validate a versioned import file, returning its entries. Throws an
 * `Error` with a human-readable, recoverable message for malformed JSON, a
 * non-object payload, an unsupported version, a missing list, or the first
 * malformed entry — so a bad file never corrupts the library.
 *
 * Unknown keys (on the envelope and every entry) are stripped, never kept.
 */
export function parseImportEnvelope<T>(json: string, spec: EnvelopeSpec<T>): T[] {
  const { label, version, listKey } = spec;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Invalid ${label} file: the file is not valid JSON.`);
  }

  const envelope = z.object({
    version: z.literal(version),
    [listKey]: z.array(spec.entry),
  });
  const result = envelope.safeParse(parsed);
  if (result.success) return result.data[listKey] as T[];

  const issue = result.error.issues[0];
  const [top, index, ...rest] = issue.path;
  if (top === undefined) {
    throw new Error(`Invalid ${label} file: expected a ${label} export object.`);
  }
  if (top === "version") {
    const found = isRecord(parsed) ? parsed.version : undefined;
    throw new Error(`Unsupported ${label} file version: ${String(found)} (expected ${version}).`);
  }
  if (typeof index !== "number") {
    throw new Error(`Invalid ${label} file: missing "${listKey}" array.`);
  }
  const raw = child(child(parsed, listKey), index);
  throw new Error(`Invalid ${label} file: ${spec.describeEntryIssue(issue, raw, index, rest)}`);
}
