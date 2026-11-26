import { create } from "zustand";

/** The two sub-tabs of a saved service's editor (#6028, slice 9). */
export type EditorView = "settings" | "activity";

interface EditorViews {
  /** By service id; Settings when none was chosen. */
  views: Record<string, EditorView>;
  show: (id: string, view: EditorView) => void;
}

/** Which sub-tab each editor shows, for this window and this session. */
export const useEditorViews = create<EditorViews>((set) => ({
  views: {},
  show: (id, view) => set((state) => ({ views: { ...state.views, [id]: view } })),
}));

/** The sub-tab of the editor of `id`; a new service has only Settings. */
export function useEditorView(id: string | null | undefined): EditorView {
  return useEditorViews((state) => (id ? (state.views[id] ?? "settings") : "settings"));
}
