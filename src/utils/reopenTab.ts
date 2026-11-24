import { toast } from "@/components/ui";
import { TerminalTab, ReopenTabPayload } from "@/types/terminal";
import { useAppStore } from "@/store/appStore";

/**
 * Build the {@link ReopenTabPayload} for a tab, or `null` when the tab cannot be
 * meaningfully reopened (non-terminal tabs, or tabs attached to a persistent
 * session — closing those only detaches, so there is nothing to undo).
 */
export function reopenPayloadForTab(
  tab: Pick<
    TerminalTab,
    "title" | "connectionType" | "config" | "contentType" | "persistentConnectionId"
  >
): ReopenTabPayload | null {
  if (tab.contentType !== "terminal") return null;
  if (tab.persistentConnectionId) return null;
  return { title: tab.title, connectionType: tab.connectionType, config: tab.config };
}

/**
 * The one id every "Closed … / Reopen" toast shares (#5828), so closing several
 * tabs updates a single toast in place instead of stacking one per tab.
 */
export const REOPEN_TOAST_ID = "th-reopen-closed-tabs";

/**
 * How long the reopen toast stays up, and how close together closes must come
 * to join one toast (#5828): a close within this long of the previous one adds
 * to the toast on screen; a later one starts a fresh toast for just that tab.
 * Replacing the toast restarts its timer, so the undo stays reachable for this
 * long after the last close.
 */
export const REOPEN_COALESCE_MS = 6000;

/** At most this many tab titles are listed under a multi-tab toast. */
const MAX_LISTED_TITLES = 3;

/** The tabs the reopen toast on screen would restore, oldest close first. */
let closedBatch: readonly ReopenTabPayload[] = [];
/** When the last tab joined {@link closedBatch} (`Date.now()`). */
let lastCloseAt = -Infinity;

/** Forget the pending batch (tests, and after Reopen). */
export function resetReopenToastBatch(): void {
  closedBatch = [];
  lastCloseAt = -Infinity;
}

/** The toast title for `closed`: the tab's name for one, a count for several. */
export function reopenToastMessage(closed: readonly ReopenTabPayload[]): string {
  if (closed.length === 1) return `Closed “${closed[0].title}”`;
  return `Closed ${closed.length} tabs`;
}

/** The secondary line naming the closed tabs, `undefined` for a single tab. */
export function reopenToastDescription(closed: readonly ReopenTabPayload[]): string | undefined {
  if (closed.length < 2) return undefined;
  const listed = closed.slice(0, MAX_LISTED_TITLES).map((p) => p.title);
  const more = closed.length - listed.length;
  return more > 0 ? `${listed.join(", ")} and ${more} more` : listed.join(", ");
}

/** Open a fresh tab for each of `closed`, in the order they were closed. */
function reopenAll(closed: readonly ReopenTabPayload[]): void {
  const { addTab } = useAppStore.getState();
  for (const payload of closed) {
    addTab(payload.title, payload.connectionType, payload.config, { contentType: "terminal" });
  }
}

/**
 * Show a success toast confirming a tab was closed, with a Reopen action that
 * opens a fresh tab from the saved connection config. No-op when `payload` is
 * null (nothing reconnectable to offer).
 *
 * Closes that come within {@link REOPEN_COALESCE_MS} of each other share one
 * toast (#5828): it is replaced in place and reads "Closed 3 tabs", and its
 * "Reopen all" restores every one of them, in the order they were closed. The
 * toast goes away when a dialog opens (#5665).
 */
export function showReopenToast(payload: ReopenTabPayload | null): void {
  if (!payload) return;
  const now = Date.now();
  // A close joins the toast on screen; once that toast is gone (timed out,
  // dismissed, taken down by a dialog), the next close starts afresh.
  if (now - lastCloseAt > REOPEN_COALESCE_MS || !toast.isActive(REOPEN_TOAST_ID)) {
    closedBatch = [];
  }
  lastCloseAt = now;
  const closed = [...closedBatch, payload];
  closedBatch = closed;
  toast.success(reopenToastMessage(closed), {
    id: REOPEN_TOAST_ID,
    description: reopenToastDescription(closed),
    duration: REOPEN_COALESCE_MS,
    testId: "reopen-tab-toast",
    // The undo belongs to the moment of closing: a dialog opened afterwards
    // (a settings confirm, an unlock) dismisses it rather than sitting beside
    // it (#5665).
    dismissOnModal: true,
    action: {
      label: closed.length === 1 ? "Reopen" : "Reopen all",
      testId: "reopen-tab-toast-action",
      onClick: () => {
        // Only this toast's tabs: a later close starts a new batch.
        if (closedBatch === closed) resetReopenToastBatch();
        reopenAll(closed);
      },
    },
  });
}
