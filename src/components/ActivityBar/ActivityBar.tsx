import { Network, FolderOpen, Settings } from "lucide-react";
import { useAppStore, SidebarView } from "@/store/appStore";
import { ActivityBarItem } from "./ActivityBarItem";
import "./ActivityBar.css";

const TOP_ITEMS: { view: SidebarView; icon: typeof Network; label: string }[] = [
  { view: "connections", icon: Network, label: "Connections" },
  { view: "files", icon: FolderOpen, label: "File Browser" },
];

const BOTTOM_ITEMS: { view: SidebarView; icon: typeof Network; label: string }[] = [
  { view: "settings", icon: Settings, label: "Settings" },
];

export function ActivityBar() {
  const sidebarView = useAppStore((s) => s.sidebarView);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const setSidebarView = useAppStore((s) => s.setSidebarView);

  return (
    <div className="activity-bar">
      <div className="activity-bar__top">
        {TOP_ITEMS.map((item) => (
          <ActivityBarItem
            key={item.view}
            icon={item.icon}
            label={item.label}
            isActive={sidebarView === item.view && !sidebarCollapsed}
            onClick={() => setSidebarView(item.view)}
          />
        ))}
      </div>
      <div className="activity-bar__bottom">
        {BOTTOM_ITEMS.map((item) => (
          <ActivityBarItem
            key={item.view}
            icon={item.icon}
            label={item.label}
            isActive={sidebarView === item.view && !sidebarCollapsed}
            onClick={() => setSidebarView(item.view)}
          />
        ))}
      </div>
    </div>
  );
}
