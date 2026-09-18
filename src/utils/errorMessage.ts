/**
 * Turn an unknown/caught value into a human-readable display string.
 *
 * `catch` clauses in TypeScript are typed `unknown`, so a thrown value may be an
 * {@link Error}, a bare string, or anything else. This is the single shared
 * helper for the ubiquitous `e instanceof Error ? e.message : String(e)` idiom —
 * use it for toast descriptions, inline error text, and log messages instead of
 * re-inlining the ternary at every call site.
 *
 * @param e the caught/unknown value.
 * @returns `e.message` for an {@link Error}, the string itself for a string,
 *   otherwise `String(e)`.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === "string") {
    return e;
  }
  return String(e);
}
