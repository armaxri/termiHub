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
}

export const useServicesView = create<ServicesView>((set) => ({
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
