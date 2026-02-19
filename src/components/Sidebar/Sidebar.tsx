import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { FileBrowser } from "./FileBrowser";
import "./Sidebar.css";

const VIEW_TITLES: Record<string, string> = {
  connections: "Connections",
  files: "File Browser",
};

export function Sidebar() {
  const sidebarView = useAppStore((s) => s.sidebarView);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const fileBrowserEnabled = useAppStore((s) => s.settings.fileBrowserEnabled);

  if (sidebarCollapsed) return null;

  const effectiveView =
    !fileBrowserEnabled && sidebarView === "files" ? "connections" : sidebarView;

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__title">{VIEW_TITLES[effectiveView]}</span>
      </div>
      <div className="sidebar__content">
        {effectiveView === "connections" && <ConnectionList />}
        {effectiveView === "files" && <FileBrowser />}
      </div>
    </div>
  );
}
