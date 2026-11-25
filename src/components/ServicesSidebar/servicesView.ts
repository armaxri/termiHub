import { create } from "zustand";
import { useAppStore } from "@/store/appStore";
import type { ServerType } from "@/types/embeddedServer";

/**
 * What the Services sidebar (#6028) remembers while the app runs (termiHub keeps
 * no UI state in browser storage), and what elsewhere asks of it.
 */
export interface ServicesView {
  /** The groups the user closed, by id. */
  closed: ReadonlySet<string>;
  toggleGroup: (id: string) => void;
  /** A new file server that was asked for; `seq` tells two apart. */
  requested: { type: ServerType; seq: number } | null;
  requestFileServer: (type: ServerType) => void;
  /** The request was taken up. */
  takeRequest: () => void;
}

export const useServicesView = create<ServicesView>((set) => ({
  closed: new Set(),
  toggleGroup: (id) =>
    set((s) => {
      const closed = new Set(s.closed);
      if (!closed.delete(id)) closed.add(id);
      return { closed };
    }),
  requested: null,
  requestFileServer: (type) =>
    set((s) => ({ requested: { type, seq: (s.requested?.seq ?? 0) + 1 } })),
  takeRequest: () => set({ requested: null }),
}));

/**
 * Show the Services view. Selecting the view that already shows would close the
 * sidebar, so that case leaves it alone.
 */
export function showServicesView(): void {
  const { sidebarView, sidebarCollapsed, setSidebarView } = useAppStore.getState();
  if (sidebarView !== "services" || sidebarCollapsed) setSidebarView("services");
}
