/**
 * The command palette's icon per keybinding action (#6158). Kept apart from the
 * binding list so an action added there (#6161) only needs a line here; an
 * action without one shows the generic command glyph.
 */
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpFromLine,
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  ClipboardCopy,
  ClipboardPaste,
  Columns2,
  Copy,
  Eraser,
  FileText,
  Keyboard,
  Layers,
  Maximize2,
  PanelLeft,
  Play,
  Radio,
  Rows2,
  Search,
  Server,
  Settings,
  Square,
  SquareStack,
  SquareTerminal,
  TextSelect,
  X,
  ExternalLink,
  AppWindow,
  ZoomIn,
  Undo2,
  ArrowRightToLine,
  ZoomOut,
  RotateCcw,
  Zap,
  type LucideIcon,
} from "lucide-react";

/** The glyph of a command that has none of its own. */
export const DEFAULT_COMMAND_ICON: LucideIcon = SquareTerminal;

const ACTION_ICONS: Record<string, LucideIcon> = {
  "toggle-sidebar": PanelLeft,
  "open-settings": Settings,
  "new-window": AppWindow,
  "show-services": Server,
  "stop-all-services": Square,
  "show-shortcuts": Keyboard,
  "new-terminal": SquareTerminal,
  "close-tab": X,
  "next-tab": ChevronRight,
  "reopen-closed-tab": Undo2,
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`switch-to-tab-${i + 1}`, ArrowRightToLine])
  ),
  "prev-tab": ChevronLeft,
  "clear-terminal": Eraser,
  "find-in-terminal": Search,
  "jump-prev-prompt": ArrowUpFromLine,
  "jump-next-prompt": ArrowDownToLine,
  "select-last-command-output": TextSelect,
  "copy-last-command-output": ClipboardCopy,
  "move-tab-to-new-window": ExternalLink,
  "toggle-macro-recording": CircleDot,
  "continue-automation": Play,
  "toggle-session-logging": FileText,
  "play-macro": Zap,
  "toggle-broadcast": Radio,
  copy: Copy,
  paste: ClipboardPaste,
  "select-all": TextSelect,
  "split-right": Columns2,
  "split-down": Rows2,
  "close-panel": X,
  "focus-up": ArrowUp,
  "focus-down": ArrowDown,
  "focus-left": ArrowLeft,
  "focus-right": ArrowRight,
  "zoom-panel": Maximize2,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
  "zoom-reset": RotateCcw,
  "new-tab-group": Layers,
  "close-tab-group": X,
  "next-tab-group": SquareStack,
  "prev-tab-group": SquareStack,
};

/** The palette icon of keybinding `action`. */
export function commandIcon(action: string): LucideIcon {
  return ACTION_ICONS[action] ?? DEFAULT_COMMAND_ICON;
}
