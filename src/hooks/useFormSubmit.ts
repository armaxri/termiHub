import { useCallback, type FormEvent } from "react";

/**
 * Build a form `onSubmit` handler that prevents the default browser submit and
 * runs `action` only when `canSubmit` is true — mirroring the primary button's
 * disabled/validation state so Enter honours it.
 *
 * Used by the Network Tools panels, whose fields are wrapped in a `<form>` with
 * the primary action as the submit button.
 *
 * @param canSubmit whether the form is currently valid/runnable.
 * @param action the primary action to run on submit.
 */
export function useFormSubmit(canSubmit: boolean, action: () => void): (e: FormEvent) => void {
  return useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (canSubmit) action();
    },
    [canSubmit, action]
  );
}
