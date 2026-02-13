import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { X, Terminal, Wifi, Cable, Globe, Settings as SettingsIcon, FileEdit, Eraser, FileDown, ClipboardCopy, ArrowRightLeft, Check, Palette } from "lucide-react";
import { TerminalTab } from "@/types/terminal";
import { ConnectionType } from "@/types/terminal";

const TYPE_ICONS: Record<ConnectionType, typeof Terminal> = {
  local: Terminal,
  ssh: Wifi,
  serial: Cable,
  telnet: Globe,
};

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
  onSetColor?: () => void;
}

export function Tab({ tab, onActivate, onClose, onClear, onSave, onCopyToClipboard, horizontalScrolling, onToggleHorizontalScrolling, isDirty, tabColor, onSetColor }: TabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id, data: { panelId: tab.panelId, type: "tab" } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
    ...(tabColor ? { borderLeft: `3px solid ${tabColor}` } : {}),
  };

  const Icon = tab.contentType === "settings" ? SettingsIcon
    : tab.contentType === "editor" ? FileEdit
    : TYPE_ICONS[tab.connectionType];
  const isTerminalTab = tab.contentType === "terminal";

  const tabElement = (
    <div
      ref={setNodeRef}
      style={style}
      className={`tab ${tab.isActive ? "tab--active" : ""}`}
      onClick={onActivate}
      {...attributes}
      {...listeners}
    >
      <Icon size={14} className="tab__icon" />
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
      <ContextMenu.Trigger asChild>
        {tabElement}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onSave?.()}
          >
            <FileDown size={14} /> Save to File
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onCopyToClipboard?.()}
          >
            <ClipboardCopy size={14} /> Copy to Clipboard
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onClear?.()}
          >
            <Eraser size={14} /> Clear Terminal
          </ContextMenu.Item>
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.CheckboxItem
            className="context-menu__item"
            checked={horizontalScrolling}
            onSelect={() => onToggleHorizontalScrolling?.()}
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
          >
            <Palette size={14} /> Set Color...
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
