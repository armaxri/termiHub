import React, { useCallback, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Check,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Eraser,
  FileDown,
  Palette,
  Pencil,
} from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { useTerminalRegistry } from "@/components/Terminal/TerminalRegistry";
import {
  toast,
  useModalPortalContainer,
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuCheckboxItem,
  MenuItem,
  MenuItemIndicator,
  MenuSeparator,
} from "@/components/ui";
import { isWindows } from "@/utils/platform";
import { errorMessage } from "@/utils/errorMessage";
import { useTerminalRightClickRouting } from "./terminalRightClick";

/**
 * Copy a terminal selection to the OS clipboard, clearing the selection only
 * once the write succeeds. A failed clipboard IPC must not silently drop the
 * selection and let the user believe they copied (FEC-018) — it is surfaced via
 * `reportError`, matching the other copy paths.
 */
export async function copyTerminalSelection(
  selection: string,
  deps: {
    writeClipboard: (text: string) => Promise<void>;
    clearSelection: () => void;
    reportError: (message: string) => void;
  }
): Promise<void> {
  try {
    await deps.writeClipboard(selection);
    deps.clearSelection();
  } catch (err) {
    deps.reportError(`Failed to copy selection: ${errorMessage(err)}`);
  }
}

/**
 * Whether a terminal right-click runs Quick Copy/Paste instead of opening the
 * context menu: only when the user opted in, or by platform default on Windows
 * (conhost convention). macOS and Linux default to the context menu (MT-UI-26).
 */
export function useTerminalQuickActionMode(): boolean {
  const rightClickBehavior = useProjectedSettings().rightClickBehavior;
  return rightClickBehavior === "quickAction" || (!rightClickBehavior && isWindows());
}

/** Props for {@link TerminalContextMenu}. */
export interface TerminalContextMenuProps {
  /** The terminal tab this surface wraps. */
  tabId: string;
  /** Run Quick Copy/Paste on right-click instead of opening the menu. */
  quickAction: boolean;
  /** `data-testid` of the context-menu trigger wrapping the terminal. */
  triggerTestId: string;
  /** Class of the element wrapping the terminal. */
  className: string;
  /** Whether horizontal scrolling is on for this tab. */
  horizontalScrolling: boolean;
  onToggleHorizontalScrolling: () => void;
  onRename: () => void;
  onSetColor: () => void;
  /** The terminal (search bar + slot). */
  children: React.ReactNode;
}

/**
 * The right-click surface of a terminal (#4915): the terminal context menu
 * (Copy Selection / Paste / Copy All, Rename, Save to File, Clear Terminal,
 * Horizontal Scrolling, Set Color…), or Quick Copy/Paste when that is the
 * configured behaviour. Used by the in-panel terminal and the zoom overlay so
 * both offer the same menu. With app mouse reporting on, a plain right-click
 * belongs to the app and Shift+right-click to termiHub (#3801).
 */
export function TerminalContextMenu({
  tabId,
  quickAction,
  triggerTestId,
  className,
  horizontalScrolling,
  onToggleHorizontalScrolling,
  onRename,
  onSetColor,
  children,
}: TerminalContextMenuProps) {
  const {
    clearTerminal,
    saveTerminalToFile,
    copyTerminalToClipboard,
    getTerminalSelection,
    clearTerminalSelection,
    copySelectionToClipboard,
    pasteToTerminal,
    isMouseReportingActive,
  } = useTerminalRegistry();
  const rightClickRouting = useTerminalRightClickRouting(isMouseReportingActive);
  // Inside the zoom overlay the menu must portal into the dialog, which disables
  // pointer events outside its content (#1868); elsewhere this is null (body).
  const portalContainer = useModalPortalContainer();
  const [menuSelection, setMenuSelection] = useState<string | null>(null);

  // Capture selection BEFORE right-click modifies it (xterm auto-selects word on right-click)
  const preRightClickSelectionRef = useRef<string | null>(null);

  // Guard against a re-entrant / doubled contextmenu gesture. When termiHub is
  // viewed over Windows Remote Desktop (mstsc, the OS session-remoting — NOT
  // termiHub's own RDP connection type) a single right-click can deliver the
  // contextmenu event more than once, each firing a paste (#2595 remote-desktop
  // follow-up). Defense-in-depth alongside the per-tab paste debounce in
  // TerminalRegistry: while a right-click paste is in flight, a second
  // contextmenu for the same gesture is ignored until it settles.
  const quickActionPastingRef = useRef(false);

  const captureSelectionBeforeRightClick = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 2) {
        preRightClickSelectionRef.current = getTerminalSelection(tabId) ?? null;
      }
    },
    [getTerminalSelection, tabId]
  );

  const handleQuickAction = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const selection = preRightClickSelectionRef.current;
      preRightClickSelectionRef.current = null;
      // The app enabled mouse reporting and xterm already forwarded this
      // right-click to it: acting on it too double-handles it — Claude Code
      // pastes on right-click itself, so the clipboard landed twice (#3801).
      if (!rightClickRouting.claimRightClick(e, tabId)) return;
      if (selection) {
        void copyTerminalSelection(selection, {
          writeClipboard,
          clearSelection: () => clearTerminalSelection(tabId),
          reportError: (message) => toast.error(message),
        });
      } else {
        if (quickActionPastingRef.current) return;
        quickActionPastingRef.current = true;
        clearTerminalSelection(tabId);
        void Promise.resolve(pasteToTerminal(tabId)).finally(() => {
          quickActionPastingRef.current = false;
        });
      }
    },
    [clearTerminalSelection, pasteToTerminal, rightClickRouting, tabId]
  );

  if (quickAction) {
    return (
      <div
        className={className}
        onPointerDownCapture={captureSelectionBeforeRightClick}
        onMouseDownCapture={(e) => rightClickRouting.onMouseDownCapture(e, tabId)}
        onContextMenu={handleQuickAction}
      >
        {children}
      </div>
    );
  }

  return (
    <ContextMenuRoot
      onOpenChange={(open) => {
        if (open) setMenuSelection(getTerminalSelection(tabId) ?? null);
      }}
    >
      <ContextMenuTrigger
        asChild
        // Preventing default before Radix's own handler keeps the menu
        // closed when the right-click belongs to the app (#3801).
        onContextMenu={(e) => rightClickRouting.claimRightClick(e, tabId)}
      >
        <div
          data-testid={triggerTestId}
          onMouseDownCapture={(e) => rightClickRouting.onMouseDownCapture(e, tabId)}
          className={className}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent container={portalContainer}>
        {menuSelection && (
          <MenuItem
            onSelect={() => copySelectionToClipboard(tabId)}
            data-testid="terminal-context-copy-selection"
          >
            <Copy size={14} /> Copy Selection
          </MenuItem>
        )}
        <MenuItem onSelect={() => pasteToTerminal(tabId)} data-testid="terminal-context-paste">
          <ClipboardPaste size={14} /> Paste
        </MenuItem>
        <MenuItem
          onSelect={() => copyTerminalToClipboard(tabId)}
          data-testid="terminal-context-copy-all"
        >
          <ClipboardCopy size={14} /> Copy All
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={onRename} data-testid="tab-context-rename">
          <Pencil size={14} /> Rename
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => saveTerminalToFile(tabId)}>
          <FileDown size={14} /> Save to File
        </MenuItem>
        <MenuItem onSelect={() => clearTerminal(tabId)}>
          <Eraser size={14} /> Clear Terminal
        </MenuItem>
        <MenuSeparator />
        <MenuCheckboxItem checked={horizontalScrolling} onSelect={onToggleHorizontalScrolling}>
          <MenuItemIndicator>
            <Check size={14} />
          </MenuItemIndicator>
          <ArrowRightLeft size={14} /> Horizontal Scrolling
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuItem onSelect={onSetColor}>
          <Palette size={14} /> Set Color...
        </MenuItem>
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
