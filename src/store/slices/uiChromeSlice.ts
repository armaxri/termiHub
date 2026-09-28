import { StateCreator } from "zustand";

import type { AppState, SidebarView } from "../appStore";
import { type LayoutConfig, DEFAULT_LAYOUT, LAYOUT_PRESETS } from "@/types/connection";
import { saveSettings as persistSettings } from "@/services/storage";
import { currentSettingsView } from "@/store/settingsBridge";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";

/**
 * UI-chrome / layout-config domain slice (ARCH-001/FES-011, appStore god-module
 * split via #2881): the sidebar state (`sidebarView` / `sidebarCollapsed` /
 * `sidebarWidth` + setters), the persisted `layoutConfig` (activity-bar
 * visibility, sidebar position, status-bar etc.) with its update / preset /
 * activity-bar-toggle actions, and the runtime-only customize-layout dialog flag.
 * The module-level `layoutPersistTimer` moves here with them: every layout write
 * shares one 300 ms debounce that persists `{ ...currentSettingsView(), layout }`
 * through `save_settings`. Extracted verbatim from the monolithic root store as a
 * behavior-preserving Zustand slice — every action still receives the shared
 * `set`/`get` typed against the full {@link AppState}, so the public store shape
 * and behavior are unchanged. `loadFromBackend` (a cross-domain hydrator) still
 * seeds `layoutConfig` / `sidebarView` / `sidebarCollapsed` from the persisted
 * settings in the root store. Mirrors the settings / update-checker / zoom slices.
 */
export interface UiChromeSlice {
  // Sidebar
  sidebarView: SidebarView;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  setSidebarView: (view: SidebarView) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;

  // Layout
  layoutConfig: LayoutConfig;
  layoutDialogOpen: boolean;
  setLayoutDialogOpen: (open: boolean) => void;
  updateLayoutConfig: (partial: Partial<LayoutConfig>) => void;
  applyLayoutPreset: (preset: "default" | "focus" | "zen") => void;
  toggleActivityBarView: (view: SidebarView) => void;
}

let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;

export const createUiChromeSlice: StateCreator<AppState, [], [], UiChromeSlice> = (set, get) => ({
  // Sidebar
  sidebarView: "connections",
  sidebarCollapsed: false,
  sidebarWidth: 260,
  setSidebarView: (view) => {
    set((state) => ({
      sidebarView: view,
      sidebarCollapsed: state.sidebarView === view && !state.sidebarCollapsed ? true : false,
    }));
    const { sidebarCollapsed, updateLayoutConfig } = get();
    updateLayoutConfig({ sidebarView: view, sidebarCollapsed });
  },
  toggleSidebar: () => {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
    const { sidebarView, sidebarCollapsed, updateLayoutConfig } = get();
    updateLayoutConfig({ sidebarView, sidebarCollapsed });
  },
  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  // Layout
  layoutConfig: DEFAULT_LAYOUT,
  layoutDialogOpen: false,

  setLayoutDialogOpen: (open) => set({ layoutDialogOpen: open }),

  updateLayoutConfig: (partial) => {
    const updated = { ...get().layoutConfig, ...partial };
    set({ layoutConfig: updated });
    if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
    layoutPersistTimer = setTimeout(() => {
      persistSettings({ ...currentSettingsView(), layout: updated }).catch((err) =>
        frontendLog("app_store", `Failed to persist layout config: ${errorMessage(err)}`)
      );
    }, 300);
  },

  applyLayoutPreset: (preset) => {
    const config = LAYOUT_PRESETS[preset];
    if (!config) return;
    set({ layoutConfig: config });
    if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
    layoutPersistTimer = setTimeout(() => {
      persistSettings({ ...currentSettingsView(), layout: config }).catch((err) =>
        frontendLog("app_store", `Failed to persist layout preset: ${errorMessage(err)}`)
      );
    }, 300);
  },

  toggleActivityBarView: (view) => {
    const REQUIRED_VIEWS: SidebarView[] = ["connections"];
    if (REQUIRED_VIEWS.includes(view)) return;
    const { layoutConfig, sidebarView, sidebarCollapsed } = get();
    const hidden = layoutConfig.hiddenActivityBarViews ?? [];
    const isCurrentlyHidden = hidden.includes(view);
    const updatedHidden = isCurrentlyHidden ? hidden.filter((v) => v !== view) : [...hidden, view];
    const updated = { ...layoutConfig, hiddenActivityBarViews: updatedHidden };
    // If hiding the currently active view, collapse the sidebar
    const shouldCollapse = !isCurrentlyHidden && sidebarView === view && !sidebarCollapsed;
    set({ layoutConfig: updated, ...(shouldCollapse ? { sidebarCollapsed: true } : {}) });
    if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
    layoutPersistTimer = setTimeout(() => {
      persistSettings({ ...currentSettingsView(), layout: updated }).catch((err) =>
        frontendLog("app_store", `Failed to persist layout config: ${errorMessage(err)}`)
      );
    }, 300);
  },
});
