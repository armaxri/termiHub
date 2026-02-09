import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { X, Terminal, Wifi, Cable, Globe } from "lucide-react";
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
}

export function Tab({ tab, onActivate, onClose }: TabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const Icon = TYPE_ICONS[tab.connectionType];

  return (
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
}
