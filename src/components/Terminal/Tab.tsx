import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  X,
  Settings as SettingsIcon,
  FileEdit,
  SquarePen,
  ScrollText,
  ArrowLeftRight,
  Puzzle,
  Columns2,
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
  Radio,
  Circle,
  LoaderCircle,
  TriangleAlert,
  Unplug,
  MonitorX,
  ListVideo,
  ArrowLeft,
  ArrowRight,
  SquareSplitHorizontal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { TerminalTab } from "@/types/terminal";
import { TabStatus } from "@/utils/tabStatus";
import { ConnectionIcon } from "@/utils/connectionIcons";
import {
  Tooltip,
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuCheckboxItem,
  MenuItem,
  MenuItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { WindowInfo } from "@/types/window";
import { buildWindowPickerEntries, hasOtherWindows, tabCountHint } from "@/utils/windowPicker";
import { macroReceivingLabel, type MacroReceivingInfo } from "@/utils/macroTabMarker";

/** Human-readable label for each connection status, used as the dot's tooltip. */
const STATUS_LABELS: Record<TabStatus, string> = {
  connecting: "Connecting",
  connected: "Connected",
  failed: "Connection failed",
  disconnected: "Disconnected",
  evicted: "Taken over by another desktop",
};

/**
 * A distinct icon shape per status (UX-014). The status indicator was previously
 * a colour-only dot, legible only on hover — failing the WCAG "use of colour"
 * criterion and unclear at a glance. Each state now has its own silhouette
 * (filled disc / spinner / warning triangle / unplugged) so it is distinguishable
 * without relying on colour or a tooltip; colour and the persistent `aria-label`
 * remain as redundant cues.
 */
const STATUS_ICON: Record<TabStatus, LucideIcon> = {
  connecting: LoaderCircle,
  connected: Circle,
  failed: TriangleAlert,
  disconnected: Unplug,
  evicted: MonitorX,
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
  /**
   * Disconnect the tab's live backend session while keeping the tab open in a
   * reconnectable state (UX-015). Provided only for terminal tabs that currently
   * hold a live session; when omitted, the "Disconnect" item is hidden.
   */
  onDisconnect?: () => void;
  /** Per-tab connection status; drives the status dot. `undefined` hides the dot. */
  status?: TabStatus;
  /**
   * Whether this tab participates in the active broadcast session (#1957). When
   * true a Radio badge is shown next to the title, visible even while the tab is
   * inactive so participation is always at a glance.
   */
  isBroadcast?: boolean;
  /**
   * Set while this tab is one of the terminals receiving a multi-target macro
   * playback (#3446). Shows a "receiving macro" badge — distinct in icon and
   * colour from the broadcast badge — with the macro name and step progress, so
   * every host a macro types into is visibly marked. `null`/`undefined` hides it.
   */
  macroReceiving?: MacroReceivingInfo | null;
  /**
   * The window that currently controls this tab's session, when it is a
   * *different* window than the one rendering the tab (#2872, follow-up to
   * SM-026). When set, a persistent badge is shown explaining that resize is
   * disabled here; clicking it focuses the owning window. Null/undefined in
   * single-window mode or when this window owns the session.
   */
  controlledByWindow?: { label: string; name: string } | null;
  /** Bring the controlling window to the foreground (#2872). */
  onFocusOwningWindow?: (label: string) => void;
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
  /**
   * Move the tab one place left in its strip — the keyboard/menu alternative to
   * dragging it (#4329). Omitted on the first tab, which disables the item.
   */
  onMoveLeft?: () => void;
  /** Move the tab one place right (#4329). Omitted on the last tab. */
  onMoveRight?: () => void;
  /** Split the tab out into a new panel (#4329). Omitted when it is alone in its panel. */
  onMoveToNewPanel?: () => void;
}

/** Context-menu items that reorder or split out a tab without dragging it (#4329). */
function TabMoveItems({
  onMoveLeft,
  onMoveRight,
  onMoveToNewPanel,
}: Pick<TabProps, "onMoveLeft" | "onMoveRight" | "onMoveToNewPanel">) {
  return (
    <>
      <MenuItem
        disabled={!onMoveLeft}
        onSelect={() => onMoveLeft?.()}
        data-testid="tab-context-move-left"
      >
        <ArrowLeft size={14} /> Move Left
      </MenuItem>
      <MenuItem
        disabled={!onMoveRight}
        onSelect={() => onMoveRight?.()}
        data-testid="tab-context-move-right"
      >
        <ArrowRight size={14} /> Move Right
      </MenuItem>
      {onMoveToNewPanel && (
        <MenuItem onSelect={() => onMoveToNewPanel()} data-testid="tab-context-move-new-panel">
          <SquareSplitHorizontal size={14} /> Move to New Panel
        </MenuItem>
      )}
    </>
  );
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
  onDisconnect,
  status,
  isBroadcast,
  macroReceiving,
  controlledByWindow,
  onFocusOwningWindow,
  displayTitle,
  windows = [],
  currentWindowLabel = null,
  onContextMenuOpenChange,
  onMoveToNewWindow,
  onMoveToWindow,
  onMoveLeft,
  onMoveRight,
  onMoveToNewPanel,
}: TabProps) {
  const moveItems = (
    <TabMoveItems
      onMoveLeft={onMoveLeft}
      onMoveRight={onMoveRight}
      onMoveToNewPanel={onMoveToNewPanel}
    />
  );
  const shownTitle = displayTitle ?? tab.title;
  // Under reduced motion the connecting glyph is static (#4039), so a steady
  // text label beside it carries the "still connecting" signal instead.
  const reducedMotion = usePrefersReducedMotion();
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
              : tab.contentType === "plugin-detail"
                ? Puzzle
                : tab.contentType === "transfer-view"
                  ? Columns2
                  : null;
  const isTerminalTab = tab.contentType === "terminal";

  // Keyboard close (A11Y2-011): the close glyph is a pointer-only affordance
  // (a nested button inside `role="tab"` is invalid), so Delete/Backspace on the
  // focused tab closes it through the same guarded path as the X. The dnd-kit
  // keyboard listener still runs for every other key.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      e.target === e.currentTarget &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    listeners?.onKeyDown?.(e);
  };
  const focusOwningWindowItem = controlledByWindow && (
    <MenuItem
      onSelect={() => onFocusOwningWindow?.(controlledByWindow.label)}
      data-testid="tab-context-focus-owning-window"
    >
      <AppWindow size={14} /> Focus {controlledByWindow.name}
    </MenuItem>
  );

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
      // Tablist semantics (#2071): override dnd-kit's default `role="button"` /
      // `tabIndex={0}` so each tab is announced as a selectable tab and the tab
      // strip uses a single roving tab stop (only the active tab is Tab-reachable;
      // ArrowLeft/Right/Home/End move focus — handled by TabBar). These must come
      // after the dnd-kit spreads to take precedence.
      role="tab"
      aria-selected={tab.isActive}
      tabIndex={tab.isActive ? 0 : -1}
      aria-keyshortcuts="Delete"
      onKeyDown={handleKeyDown}
    >
      {NonTerminalIcon ? (
        <NonTerminalIcon size={14} className="tab__icon" data-testid={`tab-icon-${tab.id}`} />
      ) : (
        <ConnectionIcon config={tab.config} size={14} className="tab__icon" />
      )}
      {status &&
        (() => {
          const StatusIcon = STATUS_ICON[status];
          return (
            <span
              className={`tab__state-dot tab__state-dot--${status}`}
              role="img"
              aria-label={STATUS_LABELS[status]}
              title={STATUS_LABELS[status]}
              data-testid={`tab-state-dot-${tab.id}`}
            >
              <StatusIcon
                size={11}
                aria-hidden
                className={status === "connecting" ? "motion-essential-spinner" : undefined}
              />
            </span>
          );
        })()}
      {status === "connecting" && reducedMotion && (
        <span className="tab__state-label" aria-hidden data-testid={`tab-state-label-${tab.id}`}>
          Connecting…
        </span>
      )}
      <span className="tab__title">
        {isDirty && (
          <span
            className="tab__dirty-dot"
            role="img"
            aria-label="Unsaved changes"
            title="Unsaved changes"
            data-testid={`tab-dirty-dot-${tab.id}`}
          />
        )}
        {shownTitle}
      </span>
      {isBroadcast && (
        <span
          className="tab__broadcast-badge"
          role="img"
          aria-label="Broadcast target: input is sent to all group members"
          title="Broadcast target"
          data-testid={`tab-broadcast-badge-${tab.id}`}
        >
          <Radio size={12} aria-hidden />
        </span>
      )}
      {macroReceiving &&
        (() => {
          const label = macroReceivingLabel(macroReceiving);
          return (
            <span
              className="tab__macro-badge"
              role="img"
              aria-label={label}
              title={label}
              data-testid={`tab-macro-badge-${tab.id}`}
            >
              <ListVideo size={12} aria-hidden />
            </span>
          );
        })()}
      {controlledByWindow && (
        <Tooltip
          content={`Taken over by ${controlledByWindow.name} — input and resize are disabled here. Click to focus that window.`}
          side="bottom"
        >
          {/* Not a nested button (A11Y2-011): a labelled image inside the tab,
              clickable with the pointer; keyboard users reach "Focus <window>"
              through the tab's context menu. */}
          <span
            className="tab__controlled-badge"
            role="img"
            onClick={(e) => {
              e.stopPropagation();
              onFocusOwningWindow?.(controlledByWindow.label);
            }}
            aria-label={`Taken over by ${controlledByWindow.name}; input and resize disabled here.`}
            data-testid={`tab-controlled-badge-${tab.id}`}
          >
            <AppWindow size={12} aria-hidden />
          </span>
        </Tooltip>
      )}
      {/* Persistence marker (#2099). The ∞ is shown ONLY on agent persistent
          shells — sessions that live on the remote agent and survive closing
          termiHub and restarting this machine. Agent-backed tabs are the ones
          opened as a `remote-session`. Every other connection type is
          multi-instance and dies with the window, so it carries no marker. */}
      {tab.persistentConnectionId && tab.config?.type === "remote-session" && (
        <span
          className="tab__persistent-badge"
          role="img"
          aria-label="Persistent session"
          title="Persistent session — lives on the agent and survives closing termiHub and restarting this machine."
          data-testid={`tab-persistent-badge-${tab.id}`}
        >
          <span aria-hidden>∞</span>
        </span>
      )}
      {tab.spawned && (
        <span
          className="tab__spawned-badge"
          title="Spawned container"
          data-testid={`tab-spawned-badge-${tab.id}`}
        >
          Spawned
        </span>
      )}
      {/* Pointer-only close glyph (A11Y2-011). A focusable button nested in
          `role="tab"` is invalid and folded its label into the tab's name, so
          it is hidden from assistive tech; keyboard users close the focused
          tab with Delete/Backspace or the "Close Tab" context-menu item. */}
      <Tooltip content="Close" side="bottom">
        <span
          className="tab__close"
          aria-hidden
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          data-testid={`tab-close-${tab.id}`}
        >
          <X size={14} />
        </span>
      </Tooltip>
    </div>
  );

  if (!isTerminalTab) {
    return (
      <ContextMenuRoot>
        <ContextMenuTrigger asChild>{tabElement}</ContextMenuTrigger>
        <ContextMenuContent>
          <MenuItem onSelect={() => onSetColor?.()} data-testid="tab-context-set-color">
            <Palette size={14} /> Set Color...
          </MenuItem>
          <MenuSeparator />
          {moveItems}
          <MenuSeparator />
          <MenuItem onSelect={() => onClose()} data-testid="tab-context-close">
            <X size={14} /> Close Tab
          </MenuItem>
        </ContextMenuContent>
      </ContextMenuRoot>
    );
  }

  return (
    <ContextMenuRoot onOpenChange={(open) => onContextMenuOpenChange?.(open)}>
      <ContextMenuTrigger asChild>{tabElement}</ContextMenuTrigger>
      <ContextMenuContent>
        <MenuItem onSelect={() => onRename?.()} data-testid="tab-context-rename">
          <Pencil size={14} /> Rename
        </MenuItem>
        {onDisconnect && (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => onDisconnect()} data-testid="tab-context-disconnect">
              <Unplug size={14} /> Disconnect
            </MenuItem>
          </>
        )}
        <MenuSeparator />
        {moveItems}
        <MenuItem onSelect={() => onMoveToNewWindow?.()} data-testid="tab-context-move-new-window">
          <ExternalLink size={14} /> Move to New Window
        </MenuItem>
        {showMoveToExisting && (
          <MenuSub>
            <MenuSubTrigger data-testid="tab-context-move-window">
              <AppWindow size={14} /> Move to Window
            </MenuSubTrigger>
            <MenuSubContent data-testid="tab-context-move-window-submenu">
              <MenuItem
                onSelect={() => onMoveToNewWindow?.()}
                data-testid="tab-context-move-window-new"
              >
                <Plus size={14} /> New Window
              </MenuItem>
              <MenuSeparator />
              {pickerEntries.map((entry) => (
                <MenuItem
                  key={entry.label}
                  disabled={entry.isCurrent}
                  onSelect={() => {
                    if (!entry.isCurrent) onMoveToWindow?.(entry.label);
                  }}
                  data-testid={`tab-context-move-window-${entry.label}`}
                >
                  <AppWindow size={14} /> {entry.name}
                  {entry.isCurrent ? (
                    <span className="ui-menu__hint">current</span>
                  ) : (
                    tabCountHint(entry.tabCount) && (
                      <span className="ui-menu__hint">{tabCountHint(entry.tabCount)}</span>
                    )
                  )}
                </MenuItem>
              ))}
            </MenuSubContent>
          </MenuSub>
        )}
        <MenuSeparator />
        <MenuItem onSelect={() => onSave?.()} data-testid="tab-context-save">
          <FileDown size={14} /> Save to File
        </MenuItem>
        <MenuItem onSelect={() => onOpenInEditor?.()} data-testid="tab-context-open-in-editor">
          <FileSearch size={14} /> Open in Editor
        </MenuItem>
        <MenuItem onSelect={() => onCopyToClipboard?.()} data-testid="tab-context-copy">
          <ClipboardCopy size={14} /> Copy All
        </MenuItem>
        <MenuItem onSelect={() => onClear?.()} data-testid="tab-context-clear">
          <Eraser size={14} /> Clear Terminal
        </MenuItem>
        <MenuSeparator />
        <MenuCheckboxItem
          checked={horizontalScrolling}
          onSelect={() => onToggleHorizontalScrolling?.()}
          data-testid="tab-context-horizontal-scroll"
        >
          <MenuItemIndicator>
            <Check size={14} />
          </MenuItemIndicator>
          <ArrowRightLeft size={14} /> Horizontal Scrolling
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuItem onSelect={() => onSetColor?.()} data-testid="tab-context-set-color">
          <Palette size={14} /> Set Color...
        </MenuItem>
        {focusOwningWindowItem}
        <MenuSeparator />
        <MenuItem onSelect={() => onClose()} data-testid="tab-context-close">
          <X size={14} /> Close Tab
        </MenuItem>
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
