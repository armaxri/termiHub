/**
 * Merge a form draft moved in from another window into an editor that already
 * holds its own unsaved values (#4760).
 *
 * "Move tabs" on window close carries a dirty Settings panel to the destination
 * window. When that window already shows Settings, the moved values are applied
 * to the existing tab instead of opening a second one. Both drafts edit the same
 * document, so the merge is three-way against the destination's saved document
 * (`base`), field by field (nested plain objects are merged per field too):
 *
 * - a field the moved draft did not change keeps the local value;
 * - a field the moved draft changed and the local draft did not takes the moved value;
 * - a field both changed to the same value keeps it;
 * - a field both changed to different values keeps the local value and is
 *   reported as a conflict, so neither edit is lost silently: the local one stays
 *   on screen and the caller tells the user which moved values were not applied.
 *
 * Arrays and other non-object values are compared and taken as a whole.
 */

/** The outcome of {@link mergeMovedDraft}. */
export interface MergedDraft<T> {
  /** The local draft with the moved changes applied. */
  values: T;
  /** Dotted paths of the fields both drafts changed differently; local kept. */
  conflicts: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Apply the changes `moved` made against `base` to `local`, per field. A field
 * both changed differently keeps `local`'s value and is named in `conflicts`.
 */
export function mergeMovedDraft<T>(local: T, moved: unknown, base: unknown): MergedDraft<T> {
  const conflicts: string[] = [];

  const merge = (l: unknown, m: unknown, b: unknown, path: string): unknown => {
    if (isPlainObject(l) && isPlainObject(m) && (b === undefined || isPlainObject(b))) {
      const baseObj = (b ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const keys = new Set([...Object.keys(l), ...Object.keys(m), ...Object.keys(baseObj)]);
      for (const key of keys) {
        const value = merge(l[key], m[key], baseObj[key], path ? `${path}.${key}` : key);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    if (sameValue(m, b) || sameValue(l, m)) return l;
    if (sameValue(l, b)) return m;
    conflicts.push(path);
    return l;
  };

  return { values: merge(local, moved, base, "") as T, conflicts };
}
