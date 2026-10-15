/**
 * Live registry of file-editor buffers, keyed by tab id (#4412).
 *
 * A file editor keeps its buffer in React component state, so the store cannot
 * see unsaved text on its own. Moving a window's tabs to another window (the
 * "Move tabs" choice when closing a window) must carry that text along, so every
 * mounted file editor registers a provider here that returns its current buffer.
 *
 * The connection, tunnel and workspace form editors and the Settings panel
 * register a form draft provider instead (#4500, #4758): it returns the editor's
 * unsaved form values with any typed secret cleared (see
 * `src/utils/formDraftSecrets.ts`). A dirty editor with no provider registered
 * (it is not mounted) cannot hand over its unsaved state: it blocks the move
 * until the user explicitly saves or discards it.
 */

/** A snapshot of one file editor's buffer at the moment it is read. */
export interface EditorBufferSnapshot {
  /** The current buffer text, including unsaved edits. */
  content: string;
  /**
   * The path the buffer belongs to. For a scratch buffer that was saved via
   * Save As this is the chosen path, not the synthetic scratch name.
   */
  filePath: string;
  /** Whether the buffer is still an unsaved scratch buffer (no file on disk). */
  scratch: boolean;
  /** Whether the buffer holds unsaved changes. */
  dirty: boolean;
}

type BufferProvider = () => EditorBufferSnapshot | null;

const providers = new Map<string, BufferProvider>();

/**
 * Register the buffer provider for `tabId`. Returns an unregister function that
 * removes only this provider, so a second instance of the same tab (the zoom
 * overlay) unmounting cannot drop the other instance's registration.
 */
export function registerEditorBuffer(tabId: string, provider: BufferProvider): () => void {
  providers.set(tabId, provider);
  return () => {
    if (providers.get(tabId) === provider) providers.delete(tabId);
  };
}

/**
 * Read `tabId`'s current buffer, or `null` when no editor is registered for it
 * or the editor has not loaded a buffer yet.
 */
export function readEditorBuffer(tabId: string): EditorBufferSnapshot | null {
  return providers.get(tabId)?.() ?? null;
}

const carried = new Map<string, string>();

/**
 * Hold the unsaved text of an editor moved in from another window until the
 * editor mounted for `tabId` takes it.
 */
export function stashCarriedBuffer(tabId: string, content: string): void {
  carried.set(tabId, content);
}

/** Take (and forget) the unsaved text carried in for `tabId`, if any. */
export function takeCarriedBuffer(tabId: string): string | null {
  const content = carried.get(tabId);
  carried.delete(tabId);
  return content ?? null;
}

import type { FormDraftKind, FormDraftSnapshot } from "@/types/window";

export type { FormDraftKind, FormDraftSnapshot };

type FormDraftProvider = () => FormDraftSnapshot | null;

const draftProviders = new Map<string, FormDraftProvider>();

/**
 * Register the form draft provider for `tabId` (#4500). The provider returns
 * `null` while the form holds no unsaved changes. Returns an unregister
 * function that removes only this provider, like {@link registerEditorBuffer}.
 */
export function registerFormDraft(tabId: string, provider: FormDraftProvider): () => void {
  draftProviders.set(tabId, provider);
  return () => {
    if (draftProviders.get(tabId) === provider) draftProviders.delete(tabId);
  };
}

/** Read `tabId`'s current form draft, or `null` when no form editor is registered. */
export function readFormDraft(tabId: string): FormDraftSnapshot | null {
  return draftProviders.get(tabId)?.() ?? null;
}

const carriedDrafts = new Map<string, FormDraftSnapshot>();

/**
 * Hold the unsaved draft of a form editor moved in from another window until
 * the editor mounted for `tabId` takes it (#4500).
 */
export function stashCarriedFormDraft(tabId: string, draft: FormDraftSnapshot): void {
  carriedDrafts.set(tabId, draft);
}

/**
 * The draft carried in for `tabId` when it is of `kind`, without forgetting it.
 * An editor reads it while it first renders (React may render more than once
 * before committing) and calls {@link forgetCarriedFormDraft} once mounted.
 */
export function peekCarriedFormDraft(
  tabId: string,
  kind: FormDraftKind
): Record<string, unknown> | null {
  const draft = carriedDrafts.get(tabId);
  return draft && draft.kind === kind ? draft.values : null;
}

/** Forget the draft carried in for `tabId`, once its editor has mounted. */
export function forgetCarriedFormDraft(tabId: string): void {
  carriedDrafts.delete(tabId);
}

type CarriedDraftListener = (draft: FormDraftSnapshot) => void;

const carriedDraftListeners = new Map<string, CarriedDraftListener>();

/**
 * Listen for drafts carried in for `tabId` after its editor has mounted
 * (#4760). A moved dirty Settings panel whose destination already shows
 * Settings is merged into that existing tab rather than opening a second one,
 * so its draft arrives at an editor that has already read its mount-time draft.
 * Returns an unsubscribe function that removes only this listener.
 */
export function subscribeCarriedFormDraft(
  tabId: string,
  listener: CarriedDraftListener
): () => void {
  carriedDraftListeners.set(tabId, listener);
  return () => {
    if (carriedDraftListeners.get(tabId) === listener) carriedDraftListeners.delete(tabId);
  };
}

/**
 * Hand `draft` to the existing tab `tabId` (#4760): straight to its mounted
 * editor when one is listening, otherwise held like {@link stashCarriedFormDraft}
 * until an editor mounts for the tab and takes it.
 */
export function deliverCarriedFormDraft(tabId: string, draft: FormDraftSnapshot): void {
  const listener = carriedDraftListeners.get(tabId);
  if (listener) {
    listener(draft);
    return;
  }
  carriedDrafts.set(tabId, draft);
}

/** Drop every registration and carried buffer or draft. Test-only reset hook. */
export function clearEditorBuffers(): void {
  providers.clear();
  carried.clear();
  draftProviders.clear();
  carriedDrafts.clear();
  carriedDraftListeners.clear();
}
