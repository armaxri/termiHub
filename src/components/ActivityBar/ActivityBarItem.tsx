import { LucideIcon } from "lucide-react";
import { Tooltip } from "@/components/ui";

import { ICON_SIZE } from "@/components/ui/iconSize";
interface ActivityBarItemProps {
  icon: LucideIcon;
  /** The glyph's lucide name, rendered as `data-icon` (#5848). */
  iconName?: string;
  label: string;
  isActive: boolean;
  onClick: () => void;
}

export function ActivityBarItem({
  icon: Icon,
  iconName,
  label,
  isActive,
  onClick,
}: ActivityBarItemProps) {
  return (
    <Tooltip content={label}>
      <button
        className={`activity-bar__item ${isActive ? "activity-bar__item--active" : ""}`}
        onClick={onClick}
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        data-testid={`activity-bar-${label.toLowerCase().replace(/\s+/g, "-")}`}
        data-icon={iconName}
      >
        <Icon size={ICON_SIZE.xl} strokeWidth={1.5} />
        {isActive && <div className="activity-bar__indicator" aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}
