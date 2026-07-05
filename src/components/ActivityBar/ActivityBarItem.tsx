import { LucideIcon } from "lucide-react";
import { Tooltip } from "@/components/ui";

interface ActivityBarItemProps {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  onClick: () => void;
}

export function ActivityBarItem({ icon: Icon, label, isActive, onClick }: ActivityBarItemProps) {
  return (
    <Tooltip content={label}>
      <button
        className={`activity-bar__item ${isActive ? "activity-bar__item--active" : ""}`}
        onClick={onClick}
        aria-label={label}
        data-testid={`activity-bar-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <Icon size={24} strokeWidth={1.5} />
        {isActive && <div className="activity-bar__indicator" />}
      </button>
    </Tooltip>
  );
}
