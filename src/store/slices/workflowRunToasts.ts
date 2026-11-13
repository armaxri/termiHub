import { toast } from "@/components/ui";

/**
 * One visible "Ran workflow …" outcome at a time (#5675).
 *
 * Every run resolves its own toast in place (its id is per workflow and
 * target), so running a few workflows in a row used to stack three or four
 * green "Ran workflow" toasts. A clean outcome (success, cancel) now replaces
 * the previous clean outcome instead: the earlier one is dismissed when the
 * next one lands. A failure is never collapsed — it persists until the user
 * dismisses it, and a later success never removes it.
 */

/** The toast id of the clean outcome on screen, if any. */
let lastCleanOutcome: string | null = null;

/**
 * A run starts on `toastId` (its loading toast). If that id held the last
 * clean outcome, it is a loading toast now, so a later outcome must not
 * dismiss it.
 */
export function claimWorkflowRunToast(toastId: string): void {
  if (lastCleanOutcome === toastId) lastCleanOutcome = null;
}

/**
 * `toastId` now shows a clean outcome: dismiss the previous clean outcome (of
 * another run) so only the newest one stays.
 */
export function collapseWorkflowRunOutcome(toastId: string): void {
  if (lastCleanOutcome !== null && lastCleanOutcome !== toastId) {
    toast.dismiss(lastCleanOutcome);
  }
  lastCleanOutcome = toastId;
}

/** `toastId` now shows a failure: it is never collapsed by a later outcome. */
export function keepWorkflowRunFailure(toastId: string): void {
  if (lastCleanOutcome === toastId) lastCleanOutcome = null;
}

/** Forget the tracked outcome (tests). */
export function resetWorkflowRunToasts(): void {
  lastCleanOutcome = null;
}
