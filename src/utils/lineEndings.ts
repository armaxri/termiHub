import type { LineEnding } from "@/types/terminal";

/**
 * Default line ending used when neither the connection nor the global
 * settings specify one. LF matches typical Unix terminals and fixes the
 * Windows-paste double-line bug out of the box.
 *
 * The actual byte-level normalization happens in the Rust backend
 * (`session::line_ending`); the frontend only resolves which ending applies
 * and pushes it to the session via `set_session_line_ending`.
 */
export const DEFAULT_LINE_ENDING: LineEnding = "lf";

/** Ordered options for the line-ending dropdowns (value + display label). */
export const LINE_ENDING_OPTIONS: ReadonlyArray<{ value: LineEnding; label: string }> = [
  { value: "lf", label: "LF (\\n) — Unix" },
  { value: "cr", label: "CR (\\r) — classic terminal" },
  { value: "crlf", label: "CRLF (\\r\\n) — Windows" },
];

/** Human-readable label for a line ending (used for the "use global default" hint). */
export function lineEndingLabel(ending: LineEnding): string {
  return LINE_ENDING_OPTIONS.find((o) => o.value === ending)?.label ?? ending;
}

/**
 * Resolve the effective line ending for a terminal: a per-connection override
 * wins, then the global default, then the built-in {@link DEFAULT_LINE_ENDING}.
 */
export function resolveLineEnding(
  perConnection: LineEnding | undefined,
  globalDefault: LineEnding | undefined
): LineEnding {
  return perConnection ?? globalDefault ?? DEFAULT_LINE_ENDING;
}
