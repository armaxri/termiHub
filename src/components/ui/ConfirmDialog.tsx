import React, { useEffect, useRef } from "react";
import { Modal } from "./Modal";
import { Button, ButtonVariant } from "./Button";
import { Toggle } from "./Toggle";
import "./ui.css";

/** Optional "don't ask again" opt-out rendered below a confirmation message. */
export interface ConfirmDontAskAgain {
  /** Current checked state. */
  checked: boolean;
  /** Called with the next value when the user flips the toggle. */
  onChange: (checked: boolean) => void;
  /** Visible label (defaults to "Don't ask again"). */
  label?: string;
  /** Test hook forwarded to the toggle. */
  "data-testid"?: string;
}

/** Props for the shared {@link ConfirmDialog} primitive. */
export interface ConfirmDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Heading text. */
  title: React.ReactNode;
  /** Body message. */
  message: React.ReactNode;
  /** Confirm button label (defaults to "Confirm"). */
  confirmLabel?: string;
  /** Cancel button label (defaults to "Cancel"). */
  cancelLabel?: string;
  /** Confirm button variant (defaults to "danger" for destructive actions). */
  confirmVariant?: ButtonVariant;
  /** When provided, renders a "don't ask again" opt-out toggle. */
  dontAskAgain?: ConfirmDontAskAgain;
  /** Invoked when the user confirms. */
  onConfirm: () => void;
  /** Invoked when the user cancels (button, ESC, scrim click). */
  onCancel: () => void;
  /** Test hook forwarded to the modal content. */
  "data-testid"?: string;
}

/**
 * The single shared confirmation dialog for destructive/irreversible actions.
 * Composes {@link Modal} + {@link Button} (+ optional {@link Toggle}) so every
 * confirm surface shares one look, motion, and safe-default behavior: the
 * Cancel button is focused on open, and Enter confirms only when Cancel does
 * not hold focus. Prefer this over hand-rolling a per-feature confirm shell.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "danger",
  dontAskAgain,
  onConfirm,
  onCancel,
  ...rest
}: ConfirmDialogProps): React.ReactElement {
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

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
      title={title}
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
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} data-testid="confirm-dialog-confirm">
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message}
      {dontAskAgain && (
        <label className="ui-confirm__ask-again">
          <Toggle
            checked={dontAskAgain.checked}
            onCheckedChange={dontAskAgain.onChange}
            aria-label={dontAskAgain.label ?? "Don't ask again"}
            data-testid={dontAskAgain["data-testid"] ?? "confirm-dialog-dont-ask-again"}
          />
          <span>{dontAskAgain.label ?? "Don't ask again"}</span>
        </label>
      )}
    </Modal>
  );
}
