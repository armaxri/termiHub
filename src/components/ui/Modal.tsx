import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { isImeComposing } from "@/utils/imeComposition";
import { Button } from "./Button";
import "./ui.css";

/**
 * The modal's content node, published so descendants can portal into the dialog
 * subtree instead of `document.body`.
 *
 * A modal Radix `Dialog` sets `pointer-events: none` on `document.body` while
 * open. Any Radix menu/select/popover that portals to `document.body` (the
 * default) therefore renders *outside* the dialog and inherits that
 * `pointer-events: none`, making it dead/unclickable in a real browser (jsdom
 * does not enforce this, so unit tests miss it — see #1868). Passing this node
 * as the Radix `Portal` `container` keeps such content inside the dialog, where
 * pointer events are enabled.
 *
 * `null` when there is no modal ancestor (or the content has not mounted yet),
 * in which case callers should fall back to Radix's default `document.body`.
 */
const ModalPortalContainerContext = React.createContext<HTMLElement | null>(null);

/**
 * Returns the nearest enclosing {@link Modal}'s content element, or `null` when
 * not inside a modal. Pass it as the `container` prop of a Radix
 * `DropdownMenu.Portal` / `Select.Portal` / `Popover.Portal` so the portalled
 * content stays clickable inside the dialog (#1868). Radix treats a `null`
 * container as "use the default", so this is safe to pass unconditionally.
 */
export function useModalPortalContainer(): HTMLElement | null {
  return React.useContext(ModalPortalContainerContext);
}

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
  /** Content width. `md` (default) is 420px; `lg` is 640px for content-heavy panels. */
  size?: "md" | "lg";
  /**
   * Key handler forwarded to the content node (e.g. Enter-to-confirm). Not
   * called for keys that belong to an IME composition.
   */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  /**
   * The modal holds unsaved input (UX2-004). While `true`, every dismiss path
   * (Escape, a click on the scrim, the X, and any {@link ModalClose} button)
   * first raises an {@link UnsavedChangesDialog}; only "Discard" forwards the
   * close to {@link ModalProps.onOpenChange | onOpenChange}. Explicit actions
   * that close the modal themselves (e.g. Save) are unaffected.
   */
  dirty?: boolean;
  /**
   * The element to focus when the modal opens, instead of Radix's default (the
   * first tabbable, usually the X). Use it for a search or name field rather
   * than `autoFocus`: `autoFocus` moves focus before the focus scope mounts, so
   * the scope records the field — not the opener — as the element to restore
   * focus to on close, and focus falls to `<body>` instead (#4332).
   */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Test hook forwarded to the content node. */
  "data-testid"?: string;
}

/**
 * Wrap a footer action (typically a Cancel {@link Button}) so clicking it
 * dismisses the enclosing {@link Modal} through the same path as Escape and the
 * X — including the {@link ModalProps.dirty | dirty} guard. The child receives
 * the click handler, so it must forward `onClick` and a ref (as `Button` does).
 */
export function ModalClose({ children }: { children: React.ReactElement }): React.ReactElement {
  return <Dialog.Close asChild>{children}</Dialog.Close>;
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
  size = "md",
  onKeyDown,
  dirty = false,
  initialFocusRef,
  ...rest
}: ModalProps): React.ReactElement {
  // Track the content node so descendants can portal into it (#1868). A callback
  // ref stored in state re-renders once the node mounts, so menus opened later
  // pick up the real container rather than falling back to `document.body`.
  const [contentEl, setContentEl] = React.useState<HTMLDivElement | null>(null);
  // The discard prompt raised by a dismiss while `dirty` (UX2-004).
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  if (!open && confirmDiscard) setConfirmDiscard(false);
  // The element that had focus when the modal opened, so focus can return to it
  // on close (#4332). Radix only restores focus to a `Dialog.Trigger`, which no
  // caller uses, and its focus scope records the wrong element when a child
  // `autoFocus`es first. Captured while rendering the open transition, i.e.
  // before any child effect or `autoFocus` moves focus.
  const [opener, setOpener] = React.useState(() => ({
    open,
    element: open ? document.activeElement : null,
  }));
  if (opener.open !== open) {
    setOpener({ open, element: open ? document.activeElement : null });
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && dirty) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(next);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        {/* The scrim carries `<testid>-overlay` so system tests can exercise
            click-outside-to-dismiss (#4010). */}
        <Dialog.Overlay
          className="ui-modal__overlay"
          data-testid={rest["data-testid"] ? `${rest["data-testid"]}-overlay` : undefined}
        />
        <Dialog.Content
          ref={setContentEl}
          className={size === "lg" ? "ui-modal ui-modal--lg" : "ui-modal"}
          data-testid={rest["data-testid"]}
          // With no `description`, opt out of `aria-describedby` explicitly
          // (Radix's documented pattern) instead of pointing it at a
          // Description element that is never rendered, which also makes
          // Radix log a missing-Description warning on every open (#3356).
          {...(description ? {} : { "aria-describedby": undefined })}
          onCloseAutoFocus={(e) => {
            // Only rescue focus that was lost with the dialog: never pull it
            // back from something that claimed it on close (a new terminal tab,
            // a follow-on dialog).
            const active = document.activeElement;
            const lost = !active || active === document.body;
            const back = opener.element;
            if (!lost || !(back instanceof HTMLElement) || !back.isConnected) return;
            e.preventDefault();
            back.focus();
          }}
          onOpenAutoFocus={(e) => {
            const target = initialFocusRef?.current;
            if (!target) return;
            e.preventDefault();
            target.focus();
          }}
          onKeyDown={
            onKeyDown
              ? (e) => {
                  // Dialog-level Enter-to-confirm etc. never act on an IME
                  // composition key (#3767).
                  if (isImeComposing(e)) return;
                  onKeyDown(e);
                }
              : undefined
          }
          onEscapeKeyDown={(e) => {
            // Escape that discards an IME preedit must not close the dialog (#3767).
            if (isImeComposing(e)) e.preventDefault();
          }}
        >
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
          <ModalPortalContainerContext.Provider value={contentEl}>
            <div className="ui-modal__body">{children}</div>
            {footer ? <div className="ui-modal__foot">{footer}</div> : null}
          </ModalPortalContainerContext.Provider>
          {/* Nested inside the content so Radix stacks it as a child layer:
              Escape or a click outside the prompt dismisses only the prompt.
              Mounted only while raised, so a clean modal carries no extra
              dialog tree. */}
          {confirmDiscard ? (
            <UnsavedChangesDialog
              open
              subject="form"
              onCancel={() => setConfirmDiscard(false)}
              onJustClose={() => {
                setConfirmDiscard(false);
                onOpenChange(false);
              }}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** What holds the unsaved changes, which picks the {@link UnsavedChangesDialog} copy. */
export type UnsavedChangesSubject = "connection" | "file" | "tunnel" | "workspace" | "form";

/** Props for the shared {@link UnsavedChangesDialog}. */
export interface UnsavedChangesDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** What holds the changes; drives the message ("This file has unsaved changes"). */
  subject: UnsavedChangesSubject;
  /** Optional display name of the item, quoted in the message. */
  name?: string;
  /** Keep editing (also fired on Escape / scrim / X). */
  onCancel: () => void;
  /** Close and drop the changes. */
  onJustClose: () => void;
  /**
   * Save, then close. When omitted (a caller that cannot save from here, such as
   * the {@link Modal} dismiss guard), only Cancel and "Discard changes" are offered.
   */
  onSaveAndClose?: () => void | Promise<void>;
}

/** The message for a subject, optionally naming the item. */
function unsavedChangesMessage(subject: UnsavedChangesSubject, name?: string): string {
  const who = name ? `“${name}”` : subject === "form" ? "You" : `This ${subject}`;
  const verb = subject === "form" && !name ? "have" : "has";
  return `${who} ${verb} unsaved changes. What would you like to do?`;
}

/**
 * The single "unsaved changes" confirmation (UISF2-005), shared by every editor
 * that can lose work on close: the connection, file, tunnel and workspace
 * editors, and the {@link Modal} dirty-dismiss guard.
 *
 * It lives beside {@link Modal} because Modal renders it for its own guard; a
 * separate module would form an import cycle.
 *
 * The message is the dialog's accessible description. The visible copy repeats
 * it for sighted users but is hidden from assistive tech, so a screen reader
 * announces it once.
 */
export function UnsavedChangesDialog({
  open,
  subject,
  name,
  onCancel,
  onJustClose,
  onSaveAndClose,
}: UnsavedChangesDialogProps): React.ReactElement {
  const message = unsavedChangesMessage(subject, name);
  return (
    <Modal
      open={open}
      onOpenChange={(isOpen) => !isOpen && onCancel()}
      title="Unsaved Changes"
      description={message}
      data-testid="unsaved-changes-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="unsaved-changes-cancel">
            Cancel
          </Button>
          <Button variant="danger" onClick={onJustClose} data-testid="unsaved-changes-just-close">
            {onSaveAndClose ? "Just Close" : "Discard changes"}
          </Button>
          {onSaveAndClose ? (
            <Button
              variant="primary"
              onClick={onSaveAndClose}
              data-testid="unsaved-changes-save-and-close"
            >
              Save &amp; Close
            </Button>
          ) : null}
        </>
      }
    >
      <p aria-hidden="true" data-testid="unsaved-changes-message">
        {message}
      </p>
    </Modal>
  );
}
