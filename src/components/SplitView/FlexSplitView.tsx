import { useCallback, useRef, useEffect } from "react";
import { Layout, Model, Actions } from "flexlayout-react";
import type { TabNode, Action, ILayoutApi } from "flexlayout-react";
import { useAppStore } from "@/store/appStore";
import {
  registerLayoutApi,
  unregisterLayoutApi,
  registerModel,
  getModel,
} from "@/utils/layoutModels";
import { useTerminalRegistry } from "@/components/Terminal/TerminalRegistry";
import { SettingsPanel } from "@/components/Settings";
import { FileEditor } from "@/components/FileEditor";
import { ConnectionEditor } from "@/components/ConnectionEditor/ConnectionEditor";
import { LogViewer } from "@/components/LogViewer";
import { TunnelEditor } from "@/components/TunnelEditor";
import { WorkspaceEditor } from "@/components/WorkspaceEditor";
import { NetworkDiagnosticPanel } from "@/components/NetworkTools/NetworkDiagnosticPanel";
import { AgentErrorTab } from "@/components/Terminal/AgentErrorTab";
import { TerminalConnectionOverlay } from "@/components/Terminal/TerminalConnectionOverlay";
import { TerminalSearchBar } from "@/components/Terminal/TerminalSearchBar";
import { TerminalDisconnectOverlay } from "@/components/Terminal/TerminalDisconnectOverlay";
import { TerminalViewModeBanner } from "@/components/Terminal/TerminalViewModeBanner";
import { TerminalReconnectPrompt } from "@/components/Terminal/TerminalReconnectPrompt";
import "flexlayout-react/style/dark.css";
import "./FlexSplitView.css";

// ---------------------------------------------------------------------------
// TerminalSlot — DOM-reparenting container for an xterm instance
// ---------------------------------------------------------------------------

interface TerminalSlotProps {
  tabId: string;
  isVisible: boolean;
}

function TerminalSlot({ tabId, isVisible }: TerminalSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const { getElement, focusTerminal, fitTerminal, parkingRef } = useTerminalRegistry();
  const tabColor = useAppStore((s) => s.tabColors[tabId]);
  const isExited = useAppStore((s) => s.terminalExitedTabs[tabId] ?? false);
  const isViewMode = useAppStore((s) => s.terminalViewMode[tabId] ?? false);
  const isReconnecting = useAppStore((s) => s.terminalReconnectingTabs[tabId] ?? false);
  const isReconnectPromptVisible = useAppStore((s) => s.terminalReconnectPrompt[tabId] ?? false);

  useEffect(() => {
    const slotEl = slotRef.current;
    if (!slotEl) return;

    // Capture ref value so cleanup uses the same node even if the ref changes
    const parkingEl = parkingRef.current;

    const tryAdopt = () => {
      const termEl = getElement(tabId);
      if (termEl && termEl.parentNode !== slotEl) {
        slotEl.appendChild(termEl);
        // Synchronous fit immediately after reparenting: getComputedStyle forces
        // layout so proposeDimensions() sees the new container dimensions.
        fitTerminal(tabId);
        // RAF fit as a second pass after the browser has painted the new layout.
        requestAnimationFrame(() => fitTerminal(tabId));
        return true;
      }
      return !!termEl;
    };

    // Terminal may not be registered yet on initial render — retry once
    if (!tryAdopt()) {
      const rafId = requestAnimationFrame(() => tryAdopt());
      return () => cancelAnimationFrame(rafId);
    }

    return () => {
      // Park the element back so it's not orphaned
      const termEl = getElement(tabId);
      if (termEl && termEl.parentNode === slotEl) {
        parkingEl?.appendChild(termEl);
      }
    };
  }, [tabId, getElement, fitTerminal, parkingRef]);

  // Focus the terminal when it becomes visible (tab activation or initial creation)
  useEffect(() => {
    if (isVisible) {
      focusTerminal(tabId);
    }
  }, [isVisible, tabId, focusTerminal]);

  return (
    <div
      ref={slotRef}
      className={`terminal-container ${isVisible ? "" : "terminal-container--hidden"}`}
      style={tabColor ? { border: `2px solid ${tabColor}` } : undefined}
    >
      {(isReconnecting || (isExited && !isViewMode)) && <TerminalDisconnectOverlay tabId={tabId} />}
      {isExited && isViewMode && (
        <>
          <TerminalViewModeBanner tabId={tabId} />
          {isReconnectPromptVisible && <TerminalReconnectPrompt tabId={tabId} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FlexSplitView — flexlayout-react based split view for the active tab group
// ---------------------------------------------------------------------------

/**
 * Renders the active tab group's layout using flexlayout-react.
 * Replaces the legacy react-resizable-panels + dnd-kit based SplitView.
 */
export function FlexSplitView() {
  const tabGroups = useAppStore((s) => s.tabGroups);
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId);
  const updateGroupModel = useAppStore((s) => s.updateGroupModel);
  const closeTabData = useAppStore((s) => s.closeTabData);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const terminalSpawnErrors = useAppStore((s) => s.terminalSpawnErrors);
  const terminalConnecting = useAppStore((s) => s.terminalConnecting);

  const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId);

  // Build or retrieve the live Model for the active group
  let model = getModel(activeTabGroupId);
  if (!model && activeGroup) {
    model = Model.fromJson(activeGroup.modelJson);
    registerModel(activeTabGroupId, model);
  }

  // Re-register the model when the active tab group changes
  useEffect(() => {
    if (!activeGroup) return;
    const existing = getModel(activeTabGroupId);
    if (!existing) {
      const newModel = Model.fromJson(activeGroup.modelJson);
      registerModel(activeTabGroupId, newModel);
    }
    // Notify store that this panel is active
    setActivePanel(activeTabGroupId);
  }, [activeTabGroupId, activeGroup, setActivePanel]);

  // Register the Layout API handle via callback ref so flexlayout's forwardRef works
  const handleLayoutRef = useCallback(
    (api: ILayoutApi | null) => {
      if (api) {
        registerLayoutApi(activeTabGroupId, api);
      } else {
        unregisterLayoutApi(activeTabGroupId);
      }
    },
    [activeTabGroupId]
  );

  const handleModelChange = useCallback(
    (updatedModel: Model, _action: Action) => {
      const json = updatedModel.toJson();
      const activeTabSet = updatedModel.getActiveTabset();
      const activeTabSetId = activeTabSet?.getId() ?? null;
      const activeTabNode = activeTabSet?.getSelectedNode?.() ?? null;
      const activeTabId = (activeTabNode as TabNode | undefined)?.getId() ?? null;
      updateGroupModel(activeTabGroupId, json, activeTabSetId, activeTabId);
    },
    [activeTabGroupId, updateGroupModel]
  );

  const handleAction = useCallback(
    (action: Action): Action | undefined => {
      if (action.type === Actions.DELETE_TAB) {
        const tabId = action.data.node as string;
        // Check for dirty editors — block deletion and show a confirmation prompt
        const isDirty = useAppStore.getState().editorDirtyTabs[tabId];
        if (isDirty) {
          const allGroups = useAppStore.getState().tabGroups;
          const tab = allGroups.flatMap((g) => g.tabs).find((t) => t.id === tabId);
          if (
            tab &&
            (tab.contentType === "connection-editor" ||
              tab.contentType === "settings" ||
              tab.contentType === "editor")
          ) {
            const group = allGroups.find((g) => g.id === activeTabGroupId);
            useAppStore.getState().setPendingCloseRequest({
              tabId,
              panelId: group?.activeTabSetId ?? tabId,
            });
            return undefined; // cancel the action
          }
        }
        closeTabData(tabId);
      }
      return action;
    },
    [activeTabGroupId, closeTabData]
  );

  const factory = useCallback(
    (node: TabNode) => {
      const tabId = node.getId();
      const tab = activeGroup?.tabs.find((t) => t.id === tabId);
      if (!tab) return <div />;

      const isVisible = node.isSelected();

      switch (tab.contentType) {
        case "settings":
          return <SettingsPanel tabId={tab.id} isVisible={isVisible} />;

        case "log-viewer":
          return <LogViewer isVisible={isVisible} />;

        case "editor":
          return <FileEditor tabId={tab.id} meta={tab.editorMeta!} isVisible={isVisible} />;

        case "connection-editor":
          return (
            <ConnectionEditor
              tabId={tab.id}
              meta={tab.connectionEditorMeta!}
              isVisible={isVisible}
            />
          );

        case "tunnel-editor":
          return <TunnelEditor tabId={tab.id} meta={tab.tunnelEditorMeta!} isVisible={isVisible} />;

        case "workspace-editor":
          return (
            <WorkspaceEditor tabId={tab.id} meta={tab.workspaceEditorMeta!} isVisible={isVisible} />
          );

        case "network-diagnostic":
          return <NetworkDiagnosticPanel meta={tab.networkDiagnosticMeta!} isVisible={isVisible} />;

        case "agent-error":
          return <AgentErrorTab tabId={tab.id} meta={tab.agentErrorMeta!} isVisible={isVisible} />;

        case "terminal": {
          const hasSpawnError = !!terminalSpawnErrors[tab.id];
          const isConnecting = terminalConnecting[tab.id] ?? false;
          if (hasSpawnError || isConnecting) {
            const sessionType =
              tab.config?.type === "agent-session"
                ? ((tab.config.config as { sessionType?: string }).sessionType ?? "")
                : "";
            return (
              <TerminalConnectionOverlay
                tabId={tab.id}
                panelId={activeGroup?.activeTabSetId ?? tab.id}
                tabTitle={tab.title}
                isVisible={isVisible}
                sessionType={sessionType}
              />
            );
          }
          return (
            <div className="flex-tab-content">
              <TerminalSearchBar tabId={tab.id} />
              <TerminalSlot tabId={tab.id} isVisible={isVisible} />
            </div>
          );
        }

        default:
          return <div />;
      }
    },
    [activeGroup, terminalSpawnErrors, terminalConnecting]
  );

  if (!model) return <div className="flex-split-view" />;

  return (
    <div className="flex-split-view">
      <Layout
        model={model}
        factory={factory}
        onModelChange={handleModelChange}
        onAction={handleAction}
        ref={handleLayoutRef}
      />
    </div>
  );
}
