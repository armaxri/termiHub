import { useEffect } from "react";
import { dismissModalStaleToasts } from "./toast";

/** An open modal dialog: the shared `Modal` and any other `aria-modal` dialog. */
const OPEN_MODAL_SELECTOR = '[aria-modal="true"]';

/** How many modal dialogs are open right now. */
function openModalCount(): number {
  return document.querySelectorAll(OPEN_MODAL_SELECTOR).length;
}

/**
 * Dismiss the toasts raised with `dismissOnModal` whenever a dialog opens
 * (#5665): a "Closed … / Reopen" undo raised before the dialog would only sit
 * beside it, over a backdrop that blocks its button. Watches the DOM rather
 * than the `Modal` component so every dialog counts, whatever opened it.
 */
export function useDismissOnModalOpen(): void {
  useEffect(() => {
    let open = openModalCount();
    const check = () => {
      const now = openModalCount();
      if (now > open) dismissModalStaleToasts();
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
