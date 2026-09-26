import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { onConnectionIdsChanged } from "@/services/events";
import type { ConnectionIdChange } from "@/types/connection";
import { connectionIdRemapper, type ConnectionIdRemap } from "@/utils/connectionIdChanges";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Run `onChanges` for every `connection-ids-changed` batch while the calling
 * component is mounted and `enabled` (#3603).
 *
 * An editor holding a saved-connection id in an unsaved draft uses this to
 * re-point the draft when the connection is renamed or moved (or a folder above
 * it is): the backend already re-pointed the persisted record (#3596), and
 * without following, saving the draft would write the old id back.
 *
 * `onChanges` receives the batch's {@link connectionIdRemapper}; apply it to the
 * whole draft at once — the changes of one batch are simultaneous (`a→b, b→c`,
 * swaps), so remapping id by id in several passes would compound them. The
 * latest `onChanges` is always called, so it may close over fresh state.
 */
export function useConnectionIdChanges(
  onChanges: (remap: ConnectionIdRemap, changes: ConnectionIdChange[]) => void,
  enabled = true
): void {
  const latest = useRef(onChanges);
  latest.current = onChanges;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    onConnectionIdsChanged((changes) => {
      if (disposed || changes.length === 0) return;
      latest.current(connectionIdRemapper(changes), changes);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err: unknown) => {
        frontendLog("connection_id_changes", `Failed to follow connection id changes: ${err}`);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);
}

/**
 * Keep a `useState` draft pointing at saved connections' current ids (#3603):
 * on each `connection-ids-changed` batch, `setDraft(prev => remapDraft(prev, remap))`.
 *
 * `remapDraft` must return `prev` itself when nothing in it changed, so an
 * unrelated rename does not re-render the editor. The remap is not a user edit:
 * editors with dirty tracking must follow it in their baseline too (see the
 * connection editor), so a draft that only followed a rename stays clean.
 */
export function useFollowConnectionIdChanges<T>(
  setDraft: Dispatch<SetStateAction<T>>,
  remapDraft: (draft: T, remap: ConnectionIdRemap) => T,
  enabled = true
): void {
  useConnectionIdChanges((remap) => {
    setDraft((prev) => remapDraft(prev, remap));
  }, enabled);
}
