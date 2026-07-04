import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import "./ui.css";

/**
 * Props for the shared {@link Modal} primitive — a token-styled skin over
 * `@radix-ui/react-dialog`. Focus trap, ESC-to-close, scroll lock, and
 * portalling all come from Radix. The overlay uses `--overlay-bg` +
 * `--overlay-blur`; the content uses `--shadow-overlay` and the shared
 * enter/exit motion (fade + 8px rise, disabled under reduced-motion).
 */
export interface ModalProps {
  /** Whether the modal is open (controlled). */
  open: boolean;
  /** Called with the next open state (Radix fires `false` on ESC / close / scrim click). */
  onOpenChange: (open: boolean) => void;
  /** Heading text shown in the modal head. */
  title: React.ReactNode;
  /** Optional description for screen readers (rendered visually hidden). */
  description?: string;
  /** Body content. */
  children: React.ReactNode;
  /** Optional footer content — typically {@link Button} actions. */
  footer?: React.ReactNode;
  /** Hide the built-in close (X) button in the head. */
  hideClose?: boolean;
  /** Test hook forwarded to the content node. */
  "data-testid"?: string;
}

/**
 * The single shared modal shell. Compose dialogs from this + {@link Button}
 * instead of hand-rolling an overlay, close button, and spacing per dialog.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  hideClose = false,
  ...rest
}: ModalProps): React.ReactElement {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-modal__overlay" />
        <Dialog.Content className="ui-modal" data-testid={rest["data-testid"]}>
          <div className="ui-modal__head">
            <Dialog.Title className="ui-modal__title">{title}</Dialog.Title>
            {!hideClose ? (
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="ui-modal__close"
                  aria-label="Close"
                  data-testid="modal-close"
                >
                  <X className="ui-modal__close-icon" aria-hidden="true" />
                </button>
              </Dialog.Close>
            ) : null}
          </div>
          {description ? (
            <Dialog.Description
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                overflow: "hidden",
                clip: "rect(0 0 0 0)",
                clipPath: "inset(50%)",
                whiteSpace: "nowrap",
              }}
            >
              {description}
            </Dialog.Description>
          ) : null}
          <div className="ui-modal__body">{children}</div>
          {footer ? <div className="ui-modal__foot">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
