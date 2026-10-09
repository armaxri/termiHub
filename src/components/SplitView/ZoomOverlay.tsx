import React from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Modal, useModalPortalContainer } from "@/components/ui";
import { isMac } from "@/utils/platform";

/** Props for {@link ZoomOverlay}. */
export interface ZoomOverlayProps {
  /** The zoomed tab's display title; also the dialog's accessible name. */
  title: string;
  /** The tab's icon, shown before the title. */
  icon: React.ReactNode;
  /** Close the overlay (Escape, Shift+Escape, the close button, a scrim click). */
  onClose: () => void;
  /** Context-menu items for a right-click on the title. Omit for no menu. */
  menu?: React.ReactNode;
  /** The zoomed surface. */
  children: React.ReactNode;
}

/** Surfaces that own the Escape key while they have focus. */
const ESCAPE_OWNERS = ".xterm, .monaco-editor";

/**
 * Leave Escape to a focused terminal or code editor (A11Y2-009, #4329): vim,
 * less, fzf and Monaco's find widget all need it. There, Shift+Escape closes the
 * overlay instead — and is not passed on, so the terminal sees nothing.
 */
function handleEscape(event: KeyboardEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest(ESCAPE_OWNERS)) return;
  if (event.shiftKey) {
    event.stopPropagation();
    return;
  }
  event.preventDefault();
}

/** The overlay title: the tab icon and name, and the right-click tab menu. */
function ZoomTitle({ title, icon, menu }: Pick<ZoomOverlayProps, "title" | "icon" | "menu">) {
  // Portal the menu into the dialog: the modal disables pointer events outside
  // its content, which would leave a menu portalled to `document.body` dead (#1868).
  const container = useModalPortalContainer();
  const label = (
    <span className="zoom-overlay__label">
      <span className="zoom-overlay__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="zoom-overlay__title">{title}</span>
    </span>
  );
  if (!menu) return label;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{label}</ContextMenu.Trigger>
      <ContextMenu.Portal container={container}>
        <ContextMenu.Content className="context-menu__content">{menu}</ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * The panel zoom overlay: one tab expanded over the whole window, built on the
 * shared {@link Modal} (A11Y2-009, #4329). It is a labelled modal dialog that
 * traps focus, closes on Escape (Shift+Escape from inside a terminal or editor)
 * and returns focus to where it was when it opened.
 */
export function ZoomOverlay({ title, icon, onClose, menu, children }: ZoomOverlayProps) {
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="full"
      title={<ZoomTitle title={title} icon={icon} menu={menu} />}
      headExtra={
        <span className="zoom-overlay__hint" data-testid="zoom-overlay-hint">
          Shift+Esc or {isMac() ? "⌘⇧↵" : "Ctrl+Shift+Enter"} to close
        </span>
      }
      onEscapeKeyDown={handleEscape}
      data-testid="zoom-overlay"
    >
      {/* Overlay host (#4331): a connection-state overlay may take focus from
          inside the zoomed surface, never from elsewhere in the app. */}
      <div className="zoom-overlay__content" data-overlay-host>
        {children}
      </div>
    </Modal>
  );
}
