import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  X,
  Settings as SettingsIcon,
  FileEdit,
  SquarePen,
  ScrollText,
  ArrowLeftRight,
  Eraser,
  FileDown,
  ClipboardCopy,
  ArrowRightLeft,
  Check,
  Palette,
  Pencil,
  FileSearch,
  ExternalLink,
  AppWindow,
  Plus,
  ChevronRight,
} from "lucide-react";
import { TerminalTab } from "@/types/terminal";
import { TabStatus } from "@/utils/tabStatus";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { Tooltip } from "@/components/ui";
import type { WindowInfo } from "@/types/window";
import { buildWindowPickerEntries, hasOtherWindows, tabCountHint } from "@/utils/windowPicker";

/** Human-readable label for each connection status, used as the dot's tooltip. */
const STATUS_LABELS: Record<TabStatus, string> = {
  connecting: "Connecting",
  connected: "Connected",
  failed: "Connection failed",
  disconnected: "Disconnected",
};

interface TabProps {
  tab: TerminalTab;
  onActivate: () => void;
  onClose: () => void;
  onClear?: () => void;
  onSave?: () => void;
  onOpenInEditor?: () => void;
  onCopyToClipboard?: () => void;
  horizontalScrolling?: boolean;
  onToggleHorizontalScrolling?: () => void;
  isDirty?: boolean;
  tabColor?: string;
  onRename?: () => void;
  onSetColor?: () => void;
  /** Per-tab connection status; drives the status dot. `undefined` hides the dot. */
  status?: TabStatus;
  /**
   * Title to display, disambiguated when two editor tabs share a basename
   * (#1640). Falls back to `tab.title` when omitted.
   */
  displayTitle?: string;
  /**
   * All currently-open native windows (#1901), used to populate the
   * "Move to Window ▸" picker. Empty until the context menu opens and the list
   * is fetched.
   */
  windows?: WindowInfo[];
  /** Runtime label of the window this tab renders in (the "current" window). */
  currentWindowLabel?: string | null;
  /** Refresh the window list — fired when the tab context menu opens (#1901). */
  onContextMenuOpenChange?: (open: boolean) => void;
  /** Tear this tab out into a brand-new window (#1901). */
  onMoveToNewWindow?: () => void;
  /** Move this tab into an existing window addressed by `label` (#1901). */
  onMoveToWindow?: (label: string) => void;
}

export function Tab({
  tab,
  onActivate,
  onClose,
  onClear,
  onSave,
  onOpenInEditor,
  onCopyToClipboard,
  horizontalScrolling,
  onToggleHorizontalScrolling,
  isDirty,
  tabColor,
  onRename,
  onSetColor,
  status,
  displayTitle,
  windows = [],
  currentWindowLabel = null,
  onContextMenuOpenChange,
  onMoveToNewWindow,
  onMoveToWindow,
}: TabProps) {
  const shownTitle = displayTitle ?? tab.title;
  const pickerEntries = buildWindowPickerEntries(windows, currentWindowLabel);
  const showMoveToExisting = hasOtherWindows(windows, currentWindowLabel);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    data: { panelId: tab.panelId, type: "tab" },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
    ...(tabColor ? { borderLeft: `3px solid ${tabColor}` } : {}),
  };

  const NonTerminalIcon =
    tab.contentType === "settings"
      ? SettingsIcon
      : tab.contentType === "log-viewer"
        ? ScrollText
        : tab.contentType === "editor"
          ? FileEdit
          : tab.contentType === "connection-editor"
            ? SquarePen
            : tab.contentType === "tunnel-editor"
              ? ArrowLeftRight
              : null;
  const isTerminalTab = tab.contentType === "terminal";

  const tabElement = (
    <div
      ref={setNodeRef}
      style={style}
      className={`tab ${tab.isActive ? "tab--active" : ""}`}
      onClick={onActivate}
      onAuxClick={(e) => {
        // Middle-click closes the tab (routes through the same live-session
        // confirmation as the X button).
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      title={shownTitle}
      data-testid={`tab-${tab.id}`}
      {...attributes}
      {...listeners}
    >
      {NonTerminalIcon ? (
        <NonTerminalIcon size={14} className="tab__icon" />
      ) : (
        <ConnectionIcon config={tab.config} size={14} className="tab__icon" />
      )}
      {status && (
        <span
          className={`tab__state-dot tab__state-dot--${status}`}
          title={STATUS_LABELS[status]}
          data-testid={`tab-state-dot-${tab.id}`}
        />
      )}
      <span className="tab__title">
        {isDirty && <span className="tab__dirty-dot" />}
        {shownTitle}
      </span>
      {tab.persistentConnectionId && <span className="tab__persistent-badge">∞</span>}
      {tab.spawned && (
        <span className="tab__spawned-badge" title="Spawned container">
          Spawned
        </span>
      )}
      <Tooltip content="Close" side="bottom">
        <button
          className="tab__close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close"
          data-testid={`tab-close-${tab.id}`}
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );

  if (!isTerminalTab) {
    return (
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{tabElement}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="context-menu__content">
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => onSetColor?.()}
              data-testid="tab-context-set-color"
            >
              <Palette size={14} /> Set Color...
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  }

  return (
    <ContextMenu.Root onOpenChange={(open) => onContextMenuOpenChange?.(open)}>
      <ContextMenu.Trigger asChild>{tabElement}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onRename?.()}
            data-testid="tab-context-rename"
          >
            <Pencil size={14} /> Rename
          </ContextMenu.Item>
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onMoveToNewWindow?.()}
            data-testid="tab-context-move-new-window"
          >
            <ExternalLink size={14} /> Move to New Window
          </ContextMenu.Item>
          {showMoveToExisting && (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger
                className="context-menu__item context-menu__sub-trigger"
                data-testid="tab-context-move-window"
              >
                <AppWindow size={14} /> Move to Window
                <ChevronRight size={14} className="context-menu__sub-arrow" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent
                  className="context-menu__content"
                  data-testid="tab-context-move-window-submenu"
                >
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => onMoveToNewWindow?.()}
                    data-testid="tab-context-move-window-new"
                  >
                    <Plus size={14} /> New Window
                  </ContextMenu.Item>
                  <ContextMenu.Separator className="context-menu__separator" />
                  {pickerEntries.map((entry) => (
                    <ContextMenu.Item
                      key={entry.label}
                      className="context-menu__item"
                      disabled={entry.isCurrent}
                      onSelect={() => {
                        if (!entry.isCurrent) onMoveToWindow?.(entry.label);
                      }}
                      data-testid={`tab-context-move-window-${entry.label}`}
                    >
                      <AppWindow size={14} /> {entry.name}
                      {entry.isCurrent ? (
                        <span className="context-menu__sub-label">current</span>
                      ) : (
                        tabCountHint(entry.tabCount) && (
                          <span className="context-menu__sub-label">
                            {tabCountHint(entry.tabCount)}
                          </span>
                        )
                      )}
                    </ContextMenu.Item>
                  ))}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          )}
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onSave?.()}
            data-testid="tab-context-save"
          >
            <FileDown size={14} /> Save to File
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onOpenInEditor?.()}
            data-testid="tab-context-open-in-editor"
          >
            <FileSearch size={14} /> Open in Editor
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onCopyToClipboard?.()}
            data-testid="tab-context-copy"
          >
            <ClipboardCopy size={14} /> Copy to Clipboard
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onClear?.()}
            data-testid="tab-context-clear"
          >
            <Eraser size={14} /> Clear Terminal
          </ContextMenu.Item>
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.CheckboxItem
            className="context-menu__item"
            checked={horizontalScrolling}
            onSelect={() => onToggleHorizontalScrolling?.()}
            data-testid="tab-context-horizontal-scroll"
          >
            <ContextMenu.ItemIndicator className="context-menu__indicator">
              <Check size={14} />
            </ContextMenu.ItemIndicator>
            <ArrowRightLeft size={14} /> Horizontal Scrolling
          </ContextMenu.CheckboxItem>
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onSetColor?.()}
            data-testid="tab-context-set-color"
          >
            <Palette size={14} /> Set Color...
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
