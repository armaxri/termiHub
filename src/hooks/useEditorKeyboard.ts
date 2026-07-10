import { useCallback, type KeyboardEvent } from "react";

/** Input `type`s that submit on Enter — single-line free-text entry only. */
const TEXT_ENTRY_TYPES = new Set(["text", "number", "password", "email", "search", "tel", "url"]);

/** Options for {@link useEditorKeyboard}. */
export interface EditorKeyboardOptions {
  /** Run the form's primary action (Enter from a single-line text input). */
  onSubmit: () => void;
  /** Dismiss/cancel the form (Escape). */
  onCancel: () => void;
  /**
   * When `false`, Enter is a no-op (mirrors a disabled primary button). Escape
   * still cancels. Defaults to `true`.
   */
  canSubmit?: boolean;
  /**
   * CSS selector for containers whose inputs are exempt from Enter-submit —
   * used for list/repeatable fields (e.g. the jump-host list) whose own inputs
   * should not save the whole form.
   */
  exemptSelector?: string;
}

/** True for a single-line free-text input (the fields that submit on Enter). */
function isTextEntry(target: EventTarget | null): target is HTMLInputElement {
  if (!(target instanceof HTMLInputElement)) return false;
  return TEXT_ENTRY_TYPES.has((target.type || "text").toLowerCase());
}

/**
 * Standard keyboard behaviour for the tab-based editors (Connection, Tunnel):
 * **Enter** from a single-line text input runs the primary action and
 * **Escape** cancels. Multi-line (`<textarea>`), non-text inputs (checkbox,
 * radio, …), and inputs inside an `exemptSelector` container never submit, so
 * list/repeatable fields keep their own Enter semantics.
 *
 * Returns an `onKeyDown` handler to spread onto the editor's root element. A
 * scoped handler (rather than a native `<form>`) avoids turning the editors'
 * many descendant `<button>`s into implicit submit buttons.
 */
export function useEditorKeyboard({
  onSubmit,
  onCancel,
  canSubmit = true,
  exemptSelector,
}: EditorKeyboardOptions): (e: KeyboardEvent) => void {
  return useCallback(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }

      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.nativeEvent.isComposing
      ) {
        const target = e.target;
        if (!isTextEntry(target)) return;
        if (exemptSelector && target.closest(exemptSelector)) return;
        if (!canSubmit) return;
        e.preventDefault();
        onSubmit();
      }
    },
    [onSubmit, onCancel, canSubmit, exemptSelector]
  );
}
