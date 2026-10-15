/**
 * Form editor side of carrying unsaved form state across a window move (#4500).
 *
 * "Move tabs" on window close hands every tab to another window. A form editor
 * (connection, tunnel, workspace) keeps its draft in component state, so it
 * registers a provider the move reads ({@link useFormDraftProvider}), and the
 * editor mounted for the moved tab in the destination window picks the draft up
 * again ({@link useCarriedFormDraft}) and stays dirty, never saved.
 */
import { useEffect, useRef, useState } from "react";
import {
  forgetCarriedFormDraft,
  peekCarriedFormDraft,
  registerFormDraft,
  type FormDraftKind,
  type FormDraftSnapshot,
} from "@/utils/editorBufferRegistry";

/**
 * Register `provider` as `tabId`'s form draft for the lifetime of the editor.
 * Read through a ref so the provider always sees the current values without
 * re-registering on every edit.
 */
export function useFormDraftProvider(tabId: string, provider: () => FormDraftSnapshot | null) {
  const providerRef = useRef(provider);
  providerRef.current = provider;
  useEffect(() => registerFormDraft(tabId, () => providerRef.current()), [tabId]);
}

/**
 * The unsaved draft carried in from another window for `tabId`, read once when
 * the editor mounts, or `null` for an editor that was not moved. The carried
 * copy is forgotten once the editor has mounted, so it is applied only once.
 */
export function useCarriedFormDraft<T>(tabId: string, kind: FormDraftKind): T | null {
  const [draft] = useState(() => peekCarriedFormDraft(tabId, kind) as T | null);
  useEffect(() => forgetCarriedFormDraft(tabId), [tabId]);
  return draft;
}
