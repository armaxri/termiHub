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
 * How long the reopen toast stays up (#5828). Every close made while it is
 * still on offer joins it (#5919), and replacing it restarts its timer, so the
 * undo stays reachable for this long after the last close. Once it is gone,
 * the next close starts a fresh toast for just that tab.
 */
export const REOPEN_COALESCE_MS = 6000;

/** At most this many tab titles are listed under a multi-tab toast. */
const MAX_LISTED_TITLES = 3;

/** The tabs the reopen toast on screen would restore, oldest close first. */
let closedBatch: readonly ReopenTabPayload[] = [];

/** Forget the pending batch (tests, and after Reopen). */
export function resetReopenToastBatch(): void {
  closedBatch = [];
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
 * Closes made while the toast is still on offer share it (#5828, #5919): it
 * is replaced in place and reads "Closed 3 tabs", and its "Reopen all"
 * restores every one of them, in the order they were closed. A
 * dialog opening hides the toast and it comes back when the dialog closes
 * (#5914), so the undo is never lost to an unrelated dialog.
 */
export function showReopenToast(payload: ReopenTabPayload | null): void {
  if (!payload) return;
  // A close joins the toast while it is still on offer, however long after the
  // last close (#5919): hidden behind a slow confirm dialog (#5914) or paused
  // under the pointer, it outlives its 6 s, and replacing it with a fresh one
  // would lose the earlier tabs' undo. Once it is gone (timed out, dismissed,
  // its Reopen pressed), the next close starts afresh.
  if (!toast.isActive(REOPEN_TOAST_ID)) closedBatch = [];
  const closed = [...closedBatch, payload];
  closedBatch = closed;
  // toast-policy: undo — offers Reopen for the tabs just closed
  toast.success(reopenToastMessage(closed), {
    id: REOPEN_TOAST_ID,
    description: reopenToastDescription(closed),
    duration: REOPEN_COALESCE_MS,
    testId: "reopen-tab-toast",
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
