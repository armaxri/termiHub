/**
 * A key-order-independent serialization of a form draft, for telling whether an
 * editor holds unsaved changes by comparing its live draft to the values it was
 * opened with (UX2-004, #4314).
 *
 * Object keys are sorted at every level, so a draft rebuilt in a different key
 * order still compares equal; array order is kept, since reordering steps is a
 * real edit. `undefined` members drop out, so an absent optional field and an
 * explicit `undefined` compare equal.
 *
 * Comparing values rather than reading react-hook-form's `formState.isDirty`
 * also covers state kept outside the form (step lists, colour grids) and
 * `setValue` writes that do not pass `shouldDirty`.
 */
export function draftKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const entries = Object.entries(v as Record<string, unknown>);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  });
}
