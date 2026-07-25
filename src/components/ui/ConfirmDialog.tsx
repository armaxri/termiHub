import React, { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { Button, ButtonVariant } from "./Button";
import { Checkbox } from "./Checkbox";
import "./ui.css";

/**
 * Intent of a {@link ConfirmDialog}, driving the tinted accent icon rendered in
 * the Modal title:
 *
 * - `danger` — destructive/irreversible action: an alert triangle in
 *   `--color-error` (the same token the danger confirm Button uses).
 * - `warn` — a heads-up before a heavy/slow action: an alert triangle in
 *   `--color-warning`.
 * - `default` — no accent icon, unless the caller supplies one via
 *   {@link ConfirmDialogProps.icon | icon} (e.g. a save glyph for the WoL
 *   "save device" modal), which renders untinted.
 */
export type ConfirmDialogVariant = "default" | "warn" | "danger";

/**
 * Optional "don't ask again" opt-out rendered below a confirmation message.
 *
 * Drawn as a {@link Checkbox} rather than a {@link Toggle}: the opt-out is
 * scoped to the confirmation, so it reads as "apply this when I press Confirm"
 * — a switch would promise that it applied the moment it was flipped.
 * Consumers are expected to honour that contract and defer the write to their
 * `onConfirm`.
 */
export interface ConfirmDontAskAgain {
  /** Current checked state. */
  checked: boolean;
  /** Called with the next value when the user ticks the checkbox. */
  onChange: (checked: boolean) => void;
  /** Visible label (defaults to "Don't ask again"). */
  label?: string;
  /** Test hook forwarded to the checkbox. */
  "data-testid"?: string;
}

/** Props for the shared {@link ConfirmDialog} primitive. */
export interface ConfirmDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Heading text. */
  title: React.ReactNode;
  /**
   * Intent driving the tinted title accent icon (defaults to `"default"`, which
   * shows no icon). `danger`/`warn` render an alert triangle tinted with
   * `--color-error` / `--color-warning`; see {@link ConfirmDialogVariant}. This
   * is presentational only — the confirm Button's colour is set independently
   * via {@link ConfirmDialogProps.confirmVariant | confirmVariant}.
   */
  variant?: ConfirmDialogVariant;
  /**
   * Optional caller-supplied title accent icon. Overrides the
   * {@link ConfirmDialogProps.variant | variant} default icon, so a
   * `variant="default"` dialog can still show a glyph (e.g. `<Save />` for the
   * WoL save modal). A caller icon on a `danger`/`warn` dialog is still tinted
   * with that variant's accent colour.
   */
  icon?: React.ReactNode;
  /** Optional description for screen readers (rendered visually hidden). */
  description?: string;
  /**
   * Plain body message (the common case). Optional so a caller may supply only
   * a richer {@link ConfirmDialogProps.children | children} body slot instead.
   */
  message?: React.ReactNode;
  /**
   * Optional body slot for richer content (a small form, extra controls, a
   * list). Rendered between {@link ConfirmDialogProps.message | message} and the
   * action row, so a caller may combine a message with extra controls or pass
   * children alone. This is what lets form-carrying confirmations (e.g. the WoL
   * "save host" modal) compose the primitive instead of a hand-rolled Modal.
   */
  children?: React.ReactNode;
  /** Confirm button label (defaults to "Confirm"). */
  confirmLabel?: string;
  /** Cancel button label (defaults to "Cancel"). */
  cancelLabel?: string;
  /** Confirm button variant (defaults to "danger" for destructive actions). */
  confirmVariant?: ButtonVariant;
  /** Disable the confirm button (e.g. while a body-slot form is invalid). */
  confirmDisabled?: boolean;
  /**
   * Forwarded to the confirm {@link Button}'s `errorToast`. Defaults to `true`;
   * set `false` when the caller's `onConfirm` reports the failure itself.
   */
  confirmErrorToast?: boolean;
  /** When provided, renders a "don't ask again" opt-out checkbox. */
  dontAskAgain?: ConfirmDontAskAgain;
  /**
   * Invoked when the user confirms. Returning a `Promise` drives the confirm
   * Button's async (pending → success/error) lifecycle.
   */
  onConfirm: () => void | Promise<void>;
  /** Invoked when the user cancels (button, ESC, scrim click). */
  onCancel: () => void;
  /**
   * Base for the action-button test ids (defaults to `"confirm-dialog"`, so the
   * Cancel/Confirm buttons and the "don't ask again" checkbox are
   * `confirm-dialog-cancel` / `confirm-dialog-confirm` /
   * `confirm-dialog-dont-ask-again`). Override it so a migrated call site keeps
   * its own historical ids (e.g. `"confirm-delete"` → `confirm-delete-cancel` /
   * `confirm-delete-confirm`) without every consumer sharing one id.
   */
  testIdBase?: string;
  /** Test hook forwarded to the modal content. */
  "data-testid"?: string;
}

/**
 * The single shared confirmation dialog for destructive/irreversible actions.
 * Composes {@link Modal} + {@link Button} (+ optional {@link Checkbox}) so every
 * confirm surface shares one look, motion, and safe-default behavior: the
 * Cancel button is focused on open, and Enter confirms only when Cancel does
 * not hold focus. Prefer this over hand-rolling a per-feature confirm shell.
 *
 * Carries a plain {@link ConfirmDialogProps.message | message} for the common
 * case; a {@link ConfirmDialogProps.children | children} body slot lets a
 * confirmation compose a small form or extra controls without dropping back to
 * a raw {@link Modal}.
 */
export function ConfirmDialog({
  open,
  title,
  variant = "default",
  icon,
  description,
  message,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "danger",
  confirmDisabled,
  confirmErrorToast,
  dontAskAgain,
  testIdBase = "confirm-dialog",
  onConfirm,
  onCancel,
  ...rest
}: ConfirmDialogProps): React.ReactElement {
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  // Resolve the title accent icon: a caller-supplied `icon` wins, otherwise the
  // danger/warn variants fall back to an alert triangle. `default` has no icon.
  const accentIcon =
    icon ?? (variant === "default" ? null : <AlertTriangle size={16} aria-hidden="true" />);
  const titleNode = accentIcon ? (
    <span className="ui-confirm__title">
      <span
        className={`ui-confirm__title-icon ui-confirm__title-icon--${variant}`}
        data-testid={`${testIdBase}-title-icon`}
      >
        {accentIcon}
      </span>
      <span>{title}</span>
    </span>
  ) : (
    title
  );

  // Focus the safe (Cancel) button on open so an accidental Enter does not
  // trigger the destructive action.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => cancelBtnRef.current?.focus());
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onOpenChange={(isOpen) => !isOpen && onCancel()}
      title={titleNode}
      description={description}
      data-testid={rest["data-testid"]}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (document.activeElement === cancelBtnRef.current) return;
          e.preventDefault();
          onConfirm();
        }
      }}
      footer={
        <>
          <Button
            ref={cancelBtnRef}
            variant="secondary"
            onClick={onCancel}
            data-testid={`${testIdBase}-cancel`}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            disabled={confirmDisabled}
            errorToast={confirmErrorToast}
            data-testid={`${testIdBase}-confirm`}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message}
      {children}
      {dontAskAgain && (
        <label className="ui-confirm__ask-again">
          <Checkbox
            checked={dontAskAgain.checked}
            onCheckedChange={dontAskAgain.onChange}
            aria-label={dontAskAgain.label ?? "Don't ask again"}
            data-testid={dontAskAgain["data-testid"] ?? `${testIdBase}-dont-ask-again`}
          />
          <span>{dontAskAgain.label ?? "Don't ask again"}</span>
        </label>
      )}
    </Modal>
  );
}
