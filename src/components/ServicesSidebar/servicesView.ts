import { create } from "zustand";
import { useAppStore } from "@/store/appStore";

/**
 * What the Services sidebar (#6028) remembers while the app runs (termiHub keeps
 * no UI state in browser storage).
 */
export interface ServicesView {
  /** The groups the user closed, by id. */
  closed: ReadonlySet<string>;
  toggleGroup: (id: string) => void;
  /** Whether the Open connections window shows (#6028, slice 6). */
  openConnections: boolean;
  setOpenConnections: (open: boolean) => void;
  /** A Stop all that was asked for elsewhere, e.g. by a shortcut, and not taken up yet. */
  stopAllRequested: boolean;
  requestStopAll: () => void;
  takeStopAll: () => void;
}

export const useServicesView = create<ServicesView>((set) => ({
  openConnections: false,
  setOpenConnections: (open) => set({ openConnections: open }),
  stopAllRequested: false,
  requestStopAll: () => set({ stopAllRequested: true }),
  takeStopAll: () => set({ stopAllRequested: false }),
  closed: new Set(),
  toggleGroup: (id) =>
    set((s) => {
      const closed = new Set(s.closed);
      if (!closed.delete(id)) closed.add(id);
      return { closed };
    }),
}));

/**
 * Show the Services view. Selecting the view that already shows would close the
 * sidebar, so that case leaves it alone.
 */
export function showServicesView(): void {
  const { sidebarView, sidebarCollapsed, setSidebarView } = useAppStore.getState();
  if (sidebarView !== "services" || sidebarCollapsed) setSidebarView("services");
}

/** Show the Services and ask its Stop all, which asks first when something is open. */
export function stopAllServices(): void {
  showServicesView();
  useServicesView.getState().requestStopAll();
}
