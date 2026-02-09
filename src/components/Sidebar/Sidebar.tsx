import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { ConnectionEditor } from "./ConnectionEditor";
import { FileBrowser } from "./FileBrowser";
import "./Sidebar.css";

const VIEW_TITLES = {
  connections: "Connections",
  files: "File Browser",
  settings: "Settings",
} as const;

export function Sidebar() {
  const sidebarView = useAppStore((s) => s.sidebarView);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const editingConnectionId = useAppStore((s) => s.editingConnectionId);

  if (sidebarCollapsed) return null;

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__title">{VIEW_TITLES[sidebarView]}</span>
      </div>
      <div className="sidebar__content">
        {sidebarView === "connections" && (
          editingConnectionId
            ? <ConnectionEditor />
            : <ConnectionList />
        )}
        {sidebarView === "files" && <FileBrowser />}
        {sidebarView === "settings" && (
          <div className="sidebar__section">Settings (coming soon)</div>
        )}
      </div>
    </div>
  );
}
