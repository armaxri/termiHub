import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { X, Terminal, Wifi, Cable, Globe, Settings as SettingsIcon, Eraser } from "lucide-react";
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
}

export function Tab({ tab, onActivate, onClose, onClear }: TabProps) {
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
  };

  const Icon = tab.contentType === "settings" ? SettingsIcon : TYPE_ICONS[tab.connectionType];
  const isTerminalTab = tab.contentType !== "settings";

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
      <span className="tab__title">{tab.title}</span>
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
            onSelect={() => onClear?.()}
          >
            <Eraser size={14} /> Clear Terminal
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
