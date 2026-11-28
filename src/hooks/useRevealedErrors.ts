import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import type { ZodFieldErrors } from "./useZodEditorForm";

/**
 * Leaf paths of a form value with a comparable string per leaf. Objects and
 * arrays recurse (`"steps.0.text"`); an empty one is a leaf of its own. Blank
 * values (`undefined`, `null`, `""`) all read as one "empty" value, so a widget
 * that normalises an unset value on mount is not mistaken for a user edit.
 */
function flattenLeaves(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);
    if (entries.length > 0) {
      for (const [key, v] of entries) {
        flattenLeaves(v, prefix ? `${prefix}.${key}` : key, out);
      }
      return;
    }
  }
  const blank = value === undefined || value === null || value === "";
  out.set(prefix, blank ? "" : JSON.stringify(value));
}

/** Whether `a` and `b` name the same field, or one lies inside the other. */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/** What {@link useRevealedErrors} returns. */
export interface RevealedErrors {
  /** The subset of the errors the user should see now. */
  shown: ZodFieldErrors;
  /**
   * Spread onto the form's root element. Leaving any control inside it
   * reveals the errors of every field edited so far.
   */
  revealProps: { onBlurCapture: (event: FocusEvent) => void };
  /** Reveal every error at once — call it when the user tries to save. */
  revealAll: () => void;
  /**
   * Treat the current values as pristine again: forget the edited and revealed
   * fields and take the next values as the new baseline. Call it right after
   * `reset` swaps the form for another one (a connection type switch, a dialog
   * reopening). Pass the values `reset` just loaded as `baseline` when they
   * may equal the current ones: without it the baseline is the next *changed*
   * value, so the user's first edit after an unchanged reset would be missed.
   */
  rebaseline: (baseline?: unknown) => void;
}

/**
 * Show a form's validation errors only once they are the user's to fix
 * (#5909): a field's error appears after the user has edited the field and
 * then left it, or for every field once they try to save. A brand-new form
 * therefore opens without a wall of "… is required." messages.
 *
 * This only decides what is *shown*. Validity and the Save gate keep reading
 * the full error map, so an invalid pristine form still cannot save — and Save
 * stays reachable (`aria-disabled`) so that trying it reveals why.
 *
 * Once revealed, a field's error tracks the value live, so fixing it clears
 * the message at once ("reward early, punish late").
 *
 * `values` is the form's complete current value; it is compared leaf by leaf
 * to tell which fields changed. `showAll` forces every error visible (a parent
 * that owns the save attempt passes its own flag).
 */
export function useRevealedErrors(
  errors: ZodFieldErrors,
  values: unknown,
  showAll = false
): RevealedErrors {
  const editedRef = useRef<Set<string>>(new Set());
  const previousRef = useRef<Map<string, string> | null>(null);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const [allRevealed, setAllRevealed] = useState(false);

  // Record which leaves changed since the last render. A changed leaf counts as
  // edited from then on, even when it is later changed back.
  useEffect(() => {
    const current = new Map<string, string>();
    flattenLeaves(values, "", current);
    const previous = previousRef.current;
    previousRef.current = current;
    if (previous === null) return;
    for (const [path, leaf] of current) {
      if (previous.get(path) !== leaf && (previous.has(path) || leaf !== "")) {
        editedRef.current.add(path);
      }
    }
    for (const [path, leaf] of previous) {
      if (!current.has(path) && leaf !== "") editedRef.current.add(path);
    }
  }, [values]);

  const onBlurCapture = useCallback(() => {
    const edited = editedRef.current;
    if (edited.size === 0) return;
    setRevealed((prev) => {
      let grew = false;
      for (const path of edited) {
        if (!prev.has(path)) {
          grew = true;
          break;
        }
      }
      return grew ? new Set([...prev, ...edited]) : prev;
    });
  }, []);

  const revealAll = useCallback(() => setAllRevealed(true), []);

  const rebaseline = useCallback((baseline?: unknown) => {
    editedRef.current = new Set();
    if (baseline === undefined) {
      previousRef.current = null;
    } else {
      const next = new Map<string, string>();
      flattenLeaves(baseline, "", next);
      previousRef.current = next;
    }
    setRevealed(new Set());
    setAllRevealed(false);
  }, []);

  const shown = useMemo(() => {
    if (showAll || allRevealed) return errors;
    const visible: ZodFieldErrors = {};
    for (const [path, message] of Object.entries(errors)) {
      for (const field of revealed) {
        if (pathsOverlap(path, field)) {
          visible[path] = message;
          break;
        }
      }
    }
    return visible;
  }, [errors, revealed, showAll, allRevealed]);

  const revealProps = useMemo(() => ({ onBlurCapture }), [onBlurCapture]);
  return { shown, revealProps, revealAll, rebaseline };
}

/** What {@link useRevealOnSave} returns. */
export interface RevealOnSave {
  /** The subset of the errors the user should see now. */
  shown: ZodFieldErrors;
  /**
   * Spread onto the element that wraps the form's fields. It reveals errors
   * when a field is left, and is where {@link RevealOnSave.revealAndFocus}
   * looks for the first invalid field.
   */
  rootProps: {
    ref: RefObject<HTMLDivElement>;
    onBlurCapture: (event: FocusEvent) => void;
  };
  /**
   * Call when the user activates an invalid Save: renders every error, then
   * moves focus to the first invalid field (`aria-invalid`, in DOM order).
   * Returns the focused element, or `null` when no field is marked invalid
   * (the caller may then focus something else that explains the block).
   */
  /**
   * Show every error and focus the first invalid field, or the first one inside
   * the element `within` selects (a step the save hint links to, #6183).
   */
  revealAndFocus: (within?: string) => HTMLElement | null;
  /** See {@link RevealedErrors.rebaseline}. */
  rebaseline: (baseline?: unknown) => void;
}

/**
 * {@link useRevealedErrors} plus the save-attempt half of the pattern (#5917):
 * a dialog keeps its Save `aria-disabled` (focusable, clickable) while the
 * form is invalid, and activating it calls `revealAndFocus` instead of saving.
 */
export function useRevealOnSave(errors: ZodFieldErrors, values: unknown): RevealOnSave {
  const { shown, revealProps, revealAll, rebaseline } = useRevealedErrors(errors, values);
  const rootRef = useRef<HTMLDivElement>(null);

  const revealAndFocus = useCallback(
    (within?: string): HTMLElement | null => {
      // Render every error first: the focus target is the first `aria-invalid`.
      flushSync(revealAll);
      const invalid = '[aria-invalid="true"]';
      const target =
        rootRef.current?.querySelector<HTMLElement>(within ? `${within} ${invalid}` : invalid) ??
        null;
      if (target) {
        target.scrollIntoView?.({ block: "center" });
        target.focus();
      }
      return target;
    },
    [revealAll]
  );

  const rootProps = useMemo(
    () => ({ ref: rootRef, onBlurCapture: revealProps.onBlurCapture }),
    [revealProps]
  );
  return { shown, rootProps, revealAndFocus, rebaseline };
}
