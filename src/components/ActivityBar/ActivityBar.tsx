import { useCallback, useState } from "react";
import {
  Network,
  FolderOpen,
  ArrowLeftRight,
  LayoutGrid,
  Clapperboard,
  History,
  Workflow,
  Server,
  Settings,
  Download,
  Upload,
  ScrollText,
  LayoutDashboard,
  Stethoscope,
  Activity,
  RefreshCw,
  Info,
  Keyboard,
  Puzzle,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore, SidebarView } from "@/store/appStore";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { OpenConnectionsModal } from "@/components/OpenConnections/OpenConnectionsModal";
import { Tooltip } from "@/components/ui";
import { getActionAccelerator } from "@/services/keybindings";
import { ActivityBarItem } from "./ActivityBarItem";
import "./ActivityBar.css";

interface ActivityBarItemDef {
  view: SidebarView;
  icon: typeof Network;
  label: string;
  experimental?: boolean;
}

interface MenuAcceleratorProps {
  /** Keybinding action id whose effective accelerator should be shown. */
  action: string;
}

/**
 * Renders an action's effective accelerator, right-aligned within a settings
 * menu row (e.g. "Settings  ⌘,"). Renders nothing when the action has no
 * binding. Uses {@link getActionAccelerator} so the label stays in sync with
 * the shortcuts overlay and any user override.
 */
function MenuAccelerator({ action }: MenuAcceleratorProps) {
  const accelerator = getActionAccelerator(action);
  if (!accelerator) return null;
  return <span className="settings-menu__item-accelerator">{accelerator}</span>;
}

const REQUIRED_ITEMS: ActivityBarItemDef[] = [
  { view: "connections", icon: Network, label: "Connections" },
];

const OPTIONAL_ITEMS: ActivityBarItemDef[] = [
  { view: "files", icon: FolderOpen, label: "File Browser" },
  { view: "recent-sessions", icon: History, label: "Recent Sessions" },
  { view: "workspaces", icon: LayoutGrid, label: "Workspaces" },
  { view: "macros", icon: Clapperboard, label: "Macros" },
  { view: "tunnels", icon: ArrowLeftRight, label: "SSH Tunnels", experimental: true },
  { view: "services", icon: Server, label: "Services", experimental: true },
  { view: "network-tools", icon: Stethoscope, label: "Network Tools", experimental: true },
  { view: "workflows", icon: Workflow, label: "Workflows", experimental: true },
  { view: "plugins", icon: Puzzle, label: "Plugins" },
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
  const setExportDialogOpen = useAppStore((s) => s.setExportDialogOpen);
  const setImportDialog = useAppStore((s) => s.setImportDialog);
  const toggleActivityBarView = useAppStore((s) => s.toggleActivityBarView);
  const showRecentSessions = useAppStore((s) => s.settings.showRecentSessions);
  const experimental = useExperimentalFeatures();

  const handleExport = useCallback(() => {
    setExportDialogOpen(true);
  }, [setExportDialogOpen]);

  const handleImport = useCallback(async () => {
    try {
      const filePath = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      const json = await readTextFile(filePath);
      setImportDialog(true, json);
    } catch (err) {
      console.error("Failed to read import file:", err);
    }
  }, [setImportDialog]);

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
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={`activity-bar${activityBarPosition === "right" ? " activity-bar--right" : ""}${horizontal ? " activity-bar--horizontal" : ""}`}
        >
          <div className="activity-bar__top">
            {visibleItems.map((item) => (
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
            <Tooltip content="Log Viewer" side={horizontal ? "bottom" : "right"}>
              <button
                className="activity-bar__item"
                aria-label="Log Viewer"
                data-testid="activity-bar-logs"
                onClick={openLogViewerTab}
              >
                <ScrollText size={24} strokeWidth={1.5} />
              </button>
            </Tooltip>
            <DropdownMenu.Root>
              <Tooltip content="Settings" side={horizontal ? "bottom" : "right"}>
                <DropdownMenu.Trigger asChild>
                  <button
                    className="activity-bar__item"
                    aria-label="Settings"
                    data-testid="activity-bar-settings"
                  >
                    <Settings size={24} strokeWidth={1.5} />
                  </button>
                </DropdownMenu.Trigger>
              </Tooltip>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="settings-menu__content"
                  side={horizontal ? "bottom" : "right"}
                  align="end"
                  sideOffset={4}
                >
                  <DropdownMenu.Item
                    className="settings-menu__item"
                    onSelect={() => openSettingsTab()}
                    data-testid="settings-menu-open"
                  >
                    <Settings size={14} />
                    Settings
                    <MenuAccelerator action="open-settings" />
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="settings-menu__item"
                    onSelect={() => setShortcutsOverlayOpen(true)}
                    data-testid="settings-menu-shortcuts"
                  >
                    <Keyboard size={14} />
                    Keyboard Shortcuts
                    <MenuAccelerator action="show-shortcuts" />
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="settings-menu__item"
                    onSelect={() => setLayoutDialogOpen(true)}
                    data-testid="settings-menu-customize-layout"
                  >
                    <LayoutDashboard size={14} />
                    Customize Layout...
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="settings-menu__item"
                    onSelect={() => setConnectionsModalOpen(true)}
                    data-testid="settings-menu-open-connections"
                  >
                    <Activity size={14} />
                    Open Connections
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="settings-menu__separator" />
                  <DropdownMenu.Item
                    className="settings-menu__item"
                    onSelect={handleImport}
                    data-testid="settings-menu-import"
                  >
                    <Upload size={14} />
                    Import Connections
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="settings-menu__item"
                    onSelect={handleExport}
                    data-testid="settings-menu-export"
                  >
                    <Download size={14} />
                    Export Connections
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="settings-menu__separator" />
                  <DropdownMenu.Item
                    className="settings-menu__item"
                    onSelect={() => openOverlayView("updates")}
                    data-testid="settings-menu-updates"
                  >
                    <RefreshCw size={14} />
                    Updates
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="settings-menu__item"
                    onSelect={() => openOverlayView("about")}
                    data-testid="settings-menu-about"
                  >
                    <Info size={14} />
                    About termiHub
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="settings-menu__content"
          data-testid="activity-bar-context-menu"
        >
          <ContextMenu.Label className="settings-menu__label">Activity Bar</ContextMenu.Label>
          <ContextMenu.Separator className="settings-menu__separator" />
          {REQUIRED_ITEMS.map((item) => (
            <ContextMenu.Item
              key={item.view}
              className="settings-menu__item settings-menu__item--required"
              disabled
              data-testid={`activity-bar-context-toggle-${item.view}`}
            >
              <span className="settings-menu__item-indicator">✓</span>
              {item.label}
            </ContextMenu.Item>
          ))}
          {availableOptionalItems.map((item) => {
            const isVisible = !hiddenActivityBarViews.includes(item.view);
            return (
              <ContextMenu.CheckboxItem
                key={item.view}
                className="settings-menu__item"
                checked={isVisible}
                onCheckedChange={() => toggleActivityBarView(item.view)}
                data-testid={`activity-bar-context-toggle-${item.view}`}
              >
                <span className="settings-menu__item-indicator">{isVisible ? "✓" : ""}</span>
                {item.label}
                {item.experimental && (
                  <span className="settings-menu__item-experimental"> — Experimental</span>
                )}
              </ContextMenu.CheckboxItem>
            );
          })}
        </ContextMenu.Content>
      </ContextMenu.Portal>
      <OpenConnectionsModal open={connectionsModalOpen} onOpenChange={setConnectionsModalOpen} />
    </ContextMenu.Root>
  );
}
