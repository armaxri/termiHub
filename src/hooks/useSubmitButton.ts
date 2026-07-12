import {
  useCallback,
  useMemo,
  useRef,
  type FormEvent,
  type MouseEvent,
  type RefObject,
} from "react";

/** Props to spread onto the `<form>` element. */
export interface SubmitFormProps {
  onSubmit: (e: FormEvent) => void;
}

/** Props to spread onto the primary `type="submit"` {@link Button}. */
export interface SubmitButtonProps {
  ref: RefObject<HTMLButtonElement>;
  type: "submit";
  disabled: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
}

/** The two prop bundles returned by {@link useSubmitButton}. */
export interface SubmitButtonBinding {
  /** Spread onto the surrounding `<form>`. */
  formProps: SubmitFormProps;
  /** Spread onto the primary submit `Button`. */
  submitProps: SubmitButtonProps;
}

/**
 * Wire a form's primary action so that pressing **Enter** and **clicking** the
 * submit button share one code path — the async {@link Button} lifecycle — and
 * one gate.
 *
 * A `<form>`'s submit button opts into the Button's idle → pending → success
 * lifecycle by returning a promise from `onClick`. Native form submission
 * (Enter), however, bypasses that click handler, so historically Enter ran the
 * bare action with no pending affordance (spinner + `pendingLabel`). This hook
 * removes that split: the `onSubmit` it returns re-dispatches through the
 * button's own `click()`, driving the identical lifecycle.
 *
 * Because both the button's `disabled` state and the `onSubmit` guard derive
 * from the single `canSubmit` argument, the Enter and click paths can never
 * drift apart (no `disabled` vs `canSubmit` divergence).
 *
 * The submit button carries `type="submit"`; its `onClick` calls
 * `preventDefault()` so a real click does not additionally trigger native
 * submission (which would double-run the action).
 *
 * @param canSubmit whether the form is currently valid/runnable — the single
 *   gate for both entry points.
 * @param action the primary action; return a promise to drive the pending
 *   affordance (and reject to drive the Button's error path).
 */
export function useSubmitButton(
  canSubmit: boolean,
  action: () => void | Promise<void>
): SubmitButtonBinding {
  const ref = useRef<HTMLButtonElement>(null);

  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>): void | Promise<void> => {
      e.preventDefault(); // stop native submit double-firing alongside the click
      return action();
    },
    [action]
  );

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      // Route Enter through the button's click so it drives the SAME async
      // Button lifecycle (pending spinner) that a mouse click does.
      ref.current?.click();
    },
    [canSubmit]
  );

  return useMemo(
    () => ({
      formProps: { onSubmit },
      submitProps: { ref, type: "submit", disabled: !canSubmit, onClick },
    }),
    [onSubmit, canSubmit, onClick]
  );
}
