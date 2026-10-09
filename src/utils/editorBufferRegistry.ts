/**
 * Live registry of file-editor buffers, keyed by tab id (#4412).
 *
 * A file editor keeps its buffer in React component state, so the store cannot
 * see unsaved text on its own. Moving a window's tabs to another window (the
 * "Move tabs" choice when closing a window) must carry that text along, so every
 * mounted file editor registers a provider here that returns its current buffer.
 *
 * Editors that do not register (the connection, tunnel, workspace and settings
 * editors) cannot hand over their unsaved form state: a dirty one blocks the
 * move until the user explicitly saves or discards it.
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

/** Drop every registration and carried buffer. Test-only reset hook. */
export function clearEditorBuffers(): void {
  providers.clear();
  carried.clear();
}
