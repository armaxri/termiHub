import { useState } from "react";
import {
  Network,
  FolderOpen,
  ArrowLeftRight,
  LayoutGrid,
  History,
  Workflow,
  Server,
  Settings,
  FileText,
  Zap,
  LayoutDashboard,
  Stethoscope,
  Activity,
  RefreshCw,
  FileArchive,
  Info,
  Keyboard,
  Puzzle,
} from "lucide-react";
import { openDiagnosticsExport } from "@/components/Diagnostics/diagnosticsDialogStore";
import { useAppStore, SidebarView } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { OpenConnectionsModal } from "@/components/OpenConnections/OpenConnectionsModal";
import {
  Tooltip,
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuCheckboxItem,
  MenuItem,
  MenuLabel,
  MenuSeparator,
} from "@/components/ui";
import { getActionAccelerator } from "@/services/keybindings";
import { ActivityBarItem } from "./ActivityBarItem";
import "./ActivityBar.css";

interface ActivityBarItemDef {
  view: SidebarView;
  icon: typeof Network;
  /** The glyph's lucide name, exposed as `data-icon` for the product-run grade (#5848). */
  iconName: string;
  label: string;
  experimental?: boolean;
}

const REQUIRED_ITEMS: ActivityBarItemDef[] = [
  { view: "connections", icon: Network, iconName: "network", label: "Connections" },
];

const OPTIONAL_ITEMS: ActivityBarItemDef[] = [
  { view: "files", icon: FolderOpen, iconName: "folder-open", label: "File browser" },
  { view: "recent-sessions", icon: History, iconName: "history", label: "Recent sessions" },
  { view: "workspaces", icon: LayoutGrid, iconName: "layout-grid", label: "Workspaces" },
  // A lightning bolt reads as "quick action"; the clapperboard read as video (#5848).
  { view: "macros", icon: Zap, iconName: "zap", label: "Macros" },
  { view: "tunnels", icon: ArrowLeftRight, iconName: "arrow-left-right", label: "SSH tunnels" },
  { view: "services", icon: Server, iconName: "server", label: "Services" },
  { view: "network-tools", icon: Stethoscope, iconName: "stethoscope", label: "Network tools" },
  {
    view: "workflows",
    icon: Workflow,
    iconName: "workflow",
    label: "Workflows",
    experimental: true,
  },
  { view: "plugins", icon: Puzzle, iconName: "puzzle", label: "Plugins" },
];

const EMPTY_HIDDEN_VIEWS: string[] = [];

interface ActivityBarProps {
  horizontal?: boolean;
}

export function ActivityBar({ horizontal }: ActivityBarProps) {
  const [connectionsModalOpen, setConnectionsModalOpen] = useState(false);
  const sidebarView = useAppStore((s) => s.sidebarView);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const setSidebarView = useAppStore((s) => s.setSidebarView);
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const openLogViewerTab = useAppStore((s) => s.openLogViewerTab);
  const openOverlayView = useAppStore((s) => s.openOverlayView);
  const setShortcutsOverlayOpen = useAppStore((s) => s.setShortcutsOverlayOpen);
  const activityBarPosition = useAppStore((s) => s.layoutConfig.activityBarPosition);
  const hiddenActivityBarViews = useAppStore(
    (s) => s.layoutConfig.hiddenActivityBarViews ?? EMPTY_HIDDEN_VIEWS
  );
  const setLayoutDialogOpen = useAppStore((s) => s.setLayoutDialogOpen);
  const toggleActivityBarView = useAppStore((s) => s.toggleActivityBarView);
  const showRecentSessions = useProjectedSettings().showRecentSessions;
  const experimental = useExperimentalFeatures();

  const availableOptionalItems = OPTIONAL_ITEMS.filter(
    (item) => (!item.experimental || experimental) && !isViewHiddenBySetting(item.view)
  );

  function isViewHiddenBySetting(view: SidebarView): boolean {
    // The Recent Sessions panel is opt-out via the session-history settings.
    return view === "recent-sessions" && showRecentSessions === false;
  }
  const visibleItems = [...REQUIRED_ITEMS, ...availableOptionalItems].filter(
    (item) => !hiddenActivityBarViews.includes(item.view)
  );

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <nav
          aria-label="Activity bar"
          data-testid="activity-bar"
          className={`activity-bar${activityBarPosition === "right" ? " activity-bar--right" : ""}${horizontal ? " activity-bar--horizontal" : ""}`}
        >
          <div className="activity-bar__top">
            {visibleItems.map((item) => (
              <ActivityBarItem
                key={item.view}
                icon={item.icon}
                iconName={item.iconName}
                label={item.label}
                isActive={sidebarView === item.view && !sidebarCollapsed}
                onClick={() => setSidebarView(item.view)}
              />
            ))}
          </div>
          <div className="activity-bar__bottom">
            <Tooltip content="Log viewer" side={horizontal ? "bottom" : "right"}>
              <button
                className="activity-bar__item"
                aria-label="Log viewer"
                data-testid="activity-bar-logs"
                data-icon="file-text"
                onClick={openLogViewerTab}
              >
                {/* A file of text lines: the conventional log glyph (#5848, R-022). */}
                <FileText size={24} strokeWidth={1.5} />
              </button>
            </Tooltip>
            <DropdownMenuRoot>
              <Tooltip content="Settings" side={horizontal ? "bottom" : "right"}>
                <DropdownMenuTrigger asChild>
                  <button
                    className="activity-bar__item"
                    aria-label="Settings"
                    data-testid="activity-bar-settings"
                    data-icon="settings"
                  >
                    <Settings size={24} strokeWidth={1.5} />
                  </button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent
                side={horizontal ? "bottom" : "right"}
                align="end"
                sideOffset={4}
              >
                <MenuItem
                  onSelect={() => openSettingsTab()}
                  data-testid="settings-menu-open"
                  shortcut={getActionAccelerator("open-settings")}
                >
                  <Settings size={14} />
                  Settings
                </MenuItem>
                <MenuItem
                  onSelect={() => setShortcutsOverlayOpen(true)}
                  data-testid="settings-menu-shortcuts"
                  shortcut={getActionAccelerator("show-shortcuts")}
                >
                  <Keyboard size={14} />
                  Keyboard shortcuts
                </MenuItem>
                <MenuItem
                  onSelect={() => setLayoutDialogOpen(true)}
                  data-testid="settings-menu-customize-layout"
                >
                  <LayoutDashboard size={14} />
                  Customize layout…
                </MenuItem>
                <MenuItem
                  onSelect={() => setConnectionsModalOpen(true)}
                  data-testid="settings-menu-open-connections"
                >
                  <Activity size={14} />
                  Open connections
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  onSelect={() => openOverlayView("updates")}
                  data-testid="settings-menu-updates"
                >
                  <RefreshCw size={14} />
                  Updates
                </MenuItem>
                <MenuItem
                  onSelect={() => openDiagnosticsExport()}
                  data-testid="settings-menu-export-diagnostics"
                >
                  <FileArchive size={14} />
                  Export diagnostics…
                </MenuItem>
                <MenuItem
                  onSelect={() => openOverlayView("about")}
                  data-testid="settings-menu-about"
                >
                  <Info size={14} />
                  About termiHub
                </MenuItem>
              </DropdownMenuContent>
            </DropdownMenuRoot>
          </div>
        </nav>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="activity-bar-context-menu">
        <MenuLabel>Activity bar</MenuLabel>
        <MenuSeparator />
        {REQUIRED_ITEMS.map((item) => (
          <MenuItem
            key={item.view}
            disabled
            data-testid={`activity-bar-context-toggle-${item.view}`}
          >
            <span className="ui-menu__indicator">✓</span>
            {item.label}
          </MenuItem>
        ))}
        {availableOptionalItems.map((item) => {
          const isVisible = !hiddenActivityBarViews.includes(item.view);
          return (
            <MenuCheckboxItem
              key={item.view}
              checked={isVisible}
              onCheckedChange={() => toggleActivityBarView(item.view)}
              data-testid={`activity-bar-context-toggle-${item.view}`}
              hint={item.experimental ? "— Experimental" : undefined}
            >
              <span className="ui-menu__indicator">{isVisible ? "✓" : ""}</span>
              {item.label}
            </MenuCheckboxItem>
          );
        })}
      </ContextMenuContent>
      <OpenConnectionsModal open={connectionsModalOpen} onOpenChange={setConnectionsModalOpen} />
    </ContextMenuRoot>
  );
}
