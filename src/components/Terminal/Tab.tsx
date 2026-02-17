import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  X,
  Settings as SettingsIcon,
  FileEdit,
  SquarePen,
  Eraser,
  FileDown,
  ClipboardCopy,
  ArrowRightLeft,
  Check,
  Palette,
  Pencil,
} from "lucide-react";
import { TerminalTab } from "@/types/terminal";
import { ConnectionIcon } from "@/utils/connectionIcons";

interface TabProps {
  tab: TerminalTab;
  onActivate: () => void;
  onClose: () => void;
  onClear?: () => void;
  onSave?: () => void;
  onCopyToClipboard?: () => void;
  horizontalScrolling?: boolean;
  onToggleHorizontalScrolling?: () => void;
  isDirty?: boolean;
  tabColor?: string;
  onRename?: () => void;
  onSetColor?: () => void;
  remoteState?: string;
}

export function Tab({
  tab,
  onActivate,
  onClose,
  onClear,
  onSave,
  onCopyToClipboard,
  horizontalScrolling,
  onToggleHorizontalScrolling,
  isDirty,
  tabColor,
  onRename,
  onSetColor,
  remoteState,
}: TabProps) {
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
      : tab.contentType === "editor"
        ? FileEdit
        : tab.contentType === "connection-editor"
          ? SquarePen
          : null;
  const isTerminalTab = tab.contentType === "terminal";

  const tabElement = (
    <div
      ref={setNodeRef}
      style={style}
      className={`tab ${tab.isActive ? "tab--active" : ""}`}
      onClick={onActivate}
      data-testid={`tab-${tab.id}`}
      {...attributes}
      {...listeners}
    >
      {NonTerminalIcon ? (
        <NonTerminalIcon size={14} className="tab__icon" />
      ) : (
        <ConnectionIcon config={tab.config} size={14} className="tab__icon" />
      )}
      {remoteState && (
        <span className={`tab__state-dot tab__state-dot--${remoteState}`} title={remoteState} />
      )}
      <span className="tab__title">
        {isDirty && <span className="tab__dirty-dot" />}
        {tab.title}
      </span>
      <button
        className="tab__close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close"
        data-testid={`tab-close-${tab.id}`}
      >
        <X size={14} />
      </button>
    </div>
  );

  if (!isTerminalTab) {
    return tabElement;
  }

  return (
    <ContextMenu.Root>
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
            onSelect={() => onSave?.()}
            data-testid="tab-context-save"
          >
            <FileDown size={14} /> Save to File
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
