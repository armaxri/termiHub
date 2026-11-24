import { useEffect } from "react";
import {
  dismissModalStaleToasts,
  hideOffersForDialog,
  restoreOffersAfterDialog,
  toast,
} from "./toast";

/** An open modal dialog: the shared `Modal` and any other `aria-modal` dialog. */
const OPEN_MODAL_SELECTOR = '[aria-modal="true"]';

/** How many modal dialogs are open right now. */
function openModalCount(): number {
  return document.querySelectorAll(OPEN_MODAL_SELECTOR).length;
}

/**
 * Dismiss the toasts raised with `dismissOnModal` whenever a dialog opens
 * (#5665): their offer is stale once a dialog takes over. The success/info
 * confirmations still showing go too (#5830): old feedback never mixes with
 * the new decision the dialog asks for. Undo offers (a toast with a button)
 * are hidden instead and come back, with their remaining lifetime, once the
 * dialog closes (#5914): an unrelated dialog never takes a recovery away.
 * Errors and loading toasts stay.
 * Watches the DOM rather than the `Modal` component so every dialog counts,
 * whatever opened it.
 */
export function useDismissOnModalOpen(): void {
  useEffect(() => {
    let open = openModalCount();
    const check = () => {
      const now = openModalCount();
      if (now > open) {
        dismissModalStaleToasts();
        hideOffersForDialog(open);
        toast.dismissTransient();
      } else if (now < open) {
        restoreOffersAfterDialog(now);
      }
      open = now;
    };
    const mutations = new MutationObserver(check);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal"],
    });
    return () => mutations.disconnect();
  }, []);
}
