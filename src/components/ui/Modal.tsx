import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
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
  /** Key handler forwarded to the content node (e.g. Enter-to-confirm). */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
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
  size = "md",
  onKeyDown,
  ...rest
}: ModalProps): React.ReactElement {
  // Track the content node so descendants can portal into it (#1868). A callback
  // ref stored in state re-renders once the node mounts, so menus opened later
  // pick up the real container rather than falling back to `document.body`.
  const [contentEl, setContentEl] = React.useState<HTMLDivElement | null>(null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-modal__overlay" />
        <Dialog.Content
          ref={setContentEl}
          className={size === "lg" ? "ui-modal ui-modal--lg" : "ui-modal"}
          data-testid={rest["data-testid"]}
          onKeyDown={onKeyDown}
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
