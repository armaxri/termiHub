import { LucideIcon } from "lucide-react";
import { Tooltip } from "@/components/ui";

interface ActivityBarItemProps {
  icon: LucideIcon;
  /** The glyph's lucide name, rendered as `data-icon` (#5848). */
  iconName?: string;
  label: string;
  /** What the test id is made of, when not the label. */
  idLabel?: string;
  isActive: boolean;
  onClick: () => void;
}

export function ActivityBarItem({
  icon: Icon,
  iconName,
  label,
  idLabel = label,
  isActive,
  onClick,
}: ActivityBarItemProps) {
  return (
    <Tooltip content={label}>
      <button
        className={`activity-bar__item ${isActive ? "activity-bar__item--active" : ""}`}
        onClick={onClick}
        aria-label={label}
        data-testid={`activity-bar-${idLabel.toLowerCase().replace(/\s+/g, "-")}`}
        data-icon={iconName}
      >
        <Icon size={24} strokeWidth={1.5} />
        {isActive && <div className="activity-bar__indicator" />}
      </button>
    </Tooltip>
  );
}
