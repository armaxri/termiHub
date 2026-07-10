import { useCallback, type FormEvent } from "react";

/**
 * Build a form `onSubmit` handler that prevents the default browser submit and
 * runs `action` only when `canSubmit` is true — mirroring the primary button's
 * disabled/validation state so Enter honours it.
 *
 * Used by the Network Tools panels, whose fields are wrapped in a `<form>` with
 * the primary action as the submit button.
 *
 * The action may return a promise and may reject: one-shot panels re-throw so a
 * mouse click drives the Button's async error path, but the Enter path has no
 * Button lifecycle, so any rejection is swallowed here (the handler already
 * surfaced the error inline/toast). This lets callers pass their stable
 * `useCallback` handler directly instead of an inline `.catch()` wrapper.
 *
 * @param canSubmit whether the form is currently valid/runnable.
 * @param action the primary action to run on submit.
 */
export function useFormSubmit(
  canSubmit: boolean,
  action: () => void | Promise<void>
): (e: FormEvent) => void {
  return useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      const result = action();
      if (result) void result.catch(() => {});
    },
    [canSubmit, action]
  );
}
