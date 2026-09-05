import { useMemo, useState } from "react";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "@/store/appStore";
import { useActivePanelId, useLayoutRenderTree } from "@/store/layoutSelectors";
import { currentSettingsView } from "@/store/settingsBridge";
import { currentSessionView, effectiveExitedMap } from "@/store/sessionBridge";
import { useProjectedBroadcast } from "@/store/useProjectedBroadcast";
import { useProjectedSessionLifecycleMaps } from "@/store/useSessionLifecycle";
import { TerminalTab } from "@/types/terminal";
import type { WindowInfo } from "@/types/window";
import { listWindows } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import { getAllLeaves } from "@/utils/panelTree";
import { getEditorTabDisplayTitle } from "@/utils/editorTabTitle";
import { deriveTabStatus } from "@/utils/tabStatus";
import { tabHasLiveSession } from "@/utils/tabLiveSession";
import { reopenPayloadForTab, showReopenToast } from "@/utils/reopenTab";
import { ConfirmDialog } from "@/components/ui";
import { useTerminalRegistry } from "./TerminalRegistry";
import { Tab } from "./Tab";
import { ColorPickerDialog } from "./ColorPickerDialog";
import { RenameDialog } from "./RenameDialog";
import "./TabBar.css";

interface TabBarProps {
  panelId: string;
  tabs: TerminalTab[];
}

export function TabBar({ panelId, tabs }: TabBarProps) {
  const isFocused = useActivePanelId() === panelId;
  const rootPanel = useLayoutRenderTree();
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const tabHorizontalScrolling = useAppStore((s) => s.tabHorizontalScrolling);
  const setTabHorizontalScrolling = useAppStore((s) => s.setTabHorizontalScrolling);
  const tabColors = useAppStore((s) => s.tabColors);
  const setTabColor = useAppStore((s) => s.setTabColor);
  const renameTab = useAppStore((s) => s.renameTab);
  const moveTabToWindow = useAppStore((s) => s.moveTabToWindow);
  const editorDirtyTabs = useAppStore((s) => s.editorDirtyTabs);
  const setPendingCloseRequest = useAppStore((s) => s.setPendingCloseRequest);
  const setPendingSessionCloseConfirm = useAppStore((s) => s.setPendingSessionCloseConfirm);
  const setPendingAttachedTabCloseConfirm = useAppStore((s) => s.setPendingAttachedTabCloseConfirm);
  // Tab-id-keyed lifecycle maps that drive the per-tab connection status dot.
  // Render cut (#2205 PR-A): the session-lifecycle maps (connecting / reconnecting
  // / disconnect errors) are sourced from the projected region (falls back to
  // appStore per key when not mirrored); spawn errors and exited tabs stay on
  // appStore (not part of the session-lifecycle region).
  const {
    terminalConnecting,
    terminalReconnectingTabs,
    terminalDisconnectErrors,
    terminalSessionLost,
    // #2621 mount-gate cut: exited tabs sourced from the region (falls back to the
    // per-client slice per key), replacing the direct `appStore.terminalExitedTabs`.
    terminalExitedTabs,
  } = useProjectedSessionLifecycleMaps();
  const terminalSpawnErrors = useAppStore((s) => s.terminalSpawnErrors);
  // Broadcast participation (#1957): the badge shows on every tab in the target
  // set, active or not, so participation is visible at a glance. Render cut
  // (#2242): sourced from the projected broadcast region (falls back to appStore).
  const broadcast = useProjectedBroadcast();
  const broadcastActive = broadcast.active;
  const broadcastTargetTabIds = broadcast.targetTabIds;
  const { clearTerminal, saveTerminalToFile, copyTerminalToClipboard, openTerminalInEditor } =
    useTerminalRegistry();

  const [colorPickerTabId, setColorPickerTabId] = useState<string | null>(null);
  const [renameTabId, setRenameTabId] = useState<string | null>(null);
  // Open native windows for the "Move to Window ▸" picker (#1901). Refreshed
  // each time a tab context menu opens, since windows live in separate JS
  // contexts and can open/close without notifying this one.
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const currentWindowLabel = useMemo(() => {
    try {
      return getCurrentWindow().label;
    } catch {
      return null;
    }
  }, []);

  // Refresh the window list when a tab context menu opens, so "Move to Window ▸"
  // always reflects the live set of windows.
  const refreshWindowsOnOpen = (open: boolean) => {
    if (!open) return;
    listWindows()
      .then(setWindows)
      .catch((err) => frontendLog("multi_window", `listWindows failed: ${String(err)}`));
  };

  // Move a tab to a new or existing window through the #1900 handoff seam.
  const handleMoveTabToWindow = (
    tabId: string,
    target: { kind: "new" } | { kind: "existing"; label: string }
  ) => {
    void moveTabToWindow(tabId, panelId, target);
  };
  // Tab awaiting confirmation in the shared unsaved-changes dialog (fallback for
  // dirty tabs whose editor does not route through `setPendingCloseRequest`).
  const [unsavedCloseTabId, setUnsavedCloseTabId] = useState<string | null>(null);

  // Continue the close flow once any unsaved-changes gate has been cleared:
  // warn before tearing down a live session, otherwise close and offer Undo.
  const finishCloseTab = (tabId: string) => {
    const state = useAppStore.getState();
    const tab = tabs.find((t) => t.id === tabId);

    if (!tab) {
      closeTab(tabId, panelId);
      return;
    }

    // A tab attached to a persistent background session is not torn down by
    // closing it — it merely detaches, leaving the process running. Show a
    // one-time reassuring notice (unless opted out) instead of the live-session
    // warning, which would wrongly imply the session ends (#1930).
    if (tab.persistentConnectionId && currentSettingsView().confirmCloseAttachedTab !== false) {
      setPendingAttachedTabCloseConfirm({ tabId, panelId, label: tab.title });
      return;
    }

    // Warn before the X / middle-click tears down a live session — unless the
    // user opted out via "Don't ask again". The keyboard close path is gated
    // separately by `confirmCloseTabOnShortcut`.
    const isLive = tabHasLiveSession(tab, {
      // #2621: region-derived exited map (OR'd with the local slice), read
      // synchronously here since this is an imperative close handler, not render.
      terminalExitedTabs: effectiveExitedMap(state.terminalExitedTabs, currentSessionView()),
      terminalSpawnErrors: state.terminalSpawnErrors,
    });
    if (isLive && currentSettingsView().confirmCloseLiveSession !== false) {
      setPendingSessionCloseConfirm({
        kind: "tab",
        tabId,
        panelId,
        label: tab.title,
        reopen: reopenPayloadForTab(tab),
      });
      return;
    }

    closeTab(tabId, panelId);
    showReopenToast(reopenPayloadForTab(tab));
  };

  const handleCloseTab = (tabId: string) => {
    // Read fresh state directly from the store to avoid stale closure values:
    // the render-time editorDirtyTabs snapshot may lag behind a setEditorDirty
    // call that hasn't caused a re-render yet (e.g. the user reverted changes).
    const state = useAppStore.getState();
    const tab = tabs.find((t) => t.id === tabId);
    const isDirty = state.editorDirtyTabs[tabId];
    if (isDirty) {
      if (
        tab?.contentType === "connection-editor" ||
        tab?.contentType === "settings" ||
        tab?.contentType === "editor"
      ) {
        setPendingCloseRequest({ tabId, panelId });
        return;
      }
      // Any other dirty tab is gated by the shared confirm dialog; the actual
      // close is deferred to `finishCloseTab` once the user confirms.
      setUnsavedCloseTabId(tabId);
      return;
    }

    finishCloseTab(tabId);
  };

  const renameTabData = renameTabId ? tabs.find((t) => t.id === renameTabId) : null;

  // Editor-tab title disambiguation (#1640) is judged across the whole active
  // tab group, so two same-basename editor tabs are distinguishable even when
  // they live in different split panels.
  const allTabs = useMemo(() => getAllLeaves(rootPanel).flatMap((leaf) => leaf.tabs), [rootPanel]);

  // Roving-focus keyboard navigation for the tab strip (#2071). Only the active
  // tab is a Tab stop (`tabIndex=0`); Arrow/Home/End move focus between the
  // `role="tab"` elements, matching the WAI-ARIA tabs pattern. Activation stays
  // on click / the app's existing shortcuts — dnd-kit owns Space/Enter for drag.
  const handleTabsKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const tabEls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    if (tabEls.length === 0) return;
    const current = tabEls.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;
    e.preventDefault();
    let next = current;
    if (e.key === "ArrowLeft") next = (current - 1 + tabEls.length) % tabEls.length;
    else if (e.key === "ArrowRight") next = (current + 1) % tabEls.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabEls.length - 1;
    tabEls[next].focus();
  };

  return (
    <div className={`tab-bar${isFocused ? " tab-bar--focused" : ""}`}>
      <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
        <div
          className="tab-bar__tabs"
          role="tablist"
          aria-label="Open sessions"
          aria-orientation="horizontal"
          onKeyDown={handleTabsKeyDown}
        >
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              tab={tab}
              onActivate={() => setActiveTab(tab.id, panelId)}
              onClose={() => handleCloseTab(tab.id)}
              onClear={() => clearTerminal(tab.id)}
              onSave={() => saveTerminalToFile(tab.id)}
              onOpenInEditor={() => openTerminalInEditor(tab.id, tab.title)}
              onCopyToClipboard={() => copyTerminalToClipboard(tab.id)}
              horizontalScrolling={tabHorizontalScrolling[tab.id] ?? false}
              onToggleHorizontalScrolling={() =>
                setTabHorizontalScrolling(tab.id, !(tabHorizontalScrolling[tab.id] ?? false))
              }
              isDirty={editorDirtyTabs[tab.id] ?? false}
              tabColor={tabColors[tab.id]}
              onRename={() => setRenameTabId(tab.id)}
              onSetColor={() => setColorPickerTabId(tab.id)}
              windows={windows}
              currentWindowLabel={currentWindowLabel}
              onContextMenuOpenChange={refreshWindowsOnOpen}
              onMoveToNewWindow={() => handleMoveTabToWindow(tab.id, { kind: "new" })}
              onMoveToWindow={(label) => handleMoveTabToWindow(tab.id, { kind: "existing", label })}
              displayTitle={getEditorTabDisplayTitle(tab, allTabs)}
              isBroadcast={broadcastActive && broadcastTargetTabIds.has(tab.id)}
              status={
                tab.contentType === "terminal"
                  ? deriveTabStatus(
                      {
                        terminalConnecting,
                        terminalReconnectingTabs,
                        terminalSpawnErrors,
                        terminalDisconnectErrors,
                        terminalExitedTabs,
                        terminalSessionLost,
                      },
                      tab.id
                    )
                  : undefined
              }
            />
          ))}
        </div>
      </SortableContext>
      <ColorPickerDialog
        open={colorPickerTabId !== null}
        onOpenChange={(open) => {
          if (!open) setColorPickerTabId(null);
        }}
        currentColor={colorPickerTabId ? tabColors[colorPickerTabId] : undefined}
        onColorChange={(color) => {
          if (colorPickerTabId) setTabColor(colorPickerTabId, color);
        }}
      />
      <RenameDialog
        open={renameTabId !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTabId(null);
        }}
        currentTitle={renameTabData?.title ?? ""}
        onRename={(newTitle) => {
          if (renameTabId) renameTab(renameTabId, newTitle);
        }}
      />
      <ConfirmDialog
        open={unsavedCloseTabId !== null}
        title="Unsaved changes"
        message="This file has unsaved changes. Close anyway?"
        confirmLabel="Close anyway"
        cancelLabel="Cancel"
        data-testid="unsaved-editor-close-dialog"
        onConfirm={() => {
          const tabId = unsavedCloseTabId;
          setUnsavedCloseTabId(null);
          if (tabId) finishCloseTab(tabId);
        }}
        onCancel={() => setUnsavedCloseTabId(null)}
      />
    </div>
  );
}
