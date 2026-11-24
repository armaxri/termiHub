/**
 * The toast an attended, canceled connect shows (#5188, #5838, #5881).
 *
 * Every connect path that a user can cancel at a dialog (the unlock dialog, a
 * password prompt) or with Abort acknowledges it the same way: the canceled
 * dialog is gone and no tab opens, so the toast names what stopped and offers
 * the next step — "Retry", or after a canceled unlock "Type password instead"
 * (the store stays locked and the connect asks for its password).
 */
import { toast } from "@/components/ui";

/** `Connect to "<name>" canceled.` (#5838). */
export function connectCanceledText(name: string): string {
  return `Connect to "${name}" canceled.`;
}

/** After a canceled unlock: the saved password stays locked (#5838). */
export function connectCanceledLockedText(name: string): string {
  return `${connectCanceledText(name)} Its saved password stays locked.`;
}

/** The action on a canceled unlock's toast (#5838), as in the unlock dialog. */
export const CONNECT_CANCELED_TYPE_PASSWORD_LABEL = "Type password instead";

/** The action on a canceled prompt's or aborted connect's toast (#5838). */
export const CONNECT_CANCELED_RETRY_LABEL = "Retry";

/** The toast's test id, and its action's. */
export const CONNECT_CANCELED_TOAST_TEST_ID = "connect-canceled-toast";
export const CONNECT_CANCELED_ACTION_TEST_ID = "connect-canceled-retry";

export interface ConnectCanceledNextStep {
  /** Start the same connect again. */
  retry: () => void;
  /**
   * Start it again without the saved credential, prompting for it. Offered
   * instead of {@link retry} after a canceled unlock; a path that cannot
   * skip the store leaves it out and offers Retry.
   */
  typePasswordInstead?: () => void;
}

/**
 * Acknowledge the attended cancel of the connect to `name`. `after` is what
 * the user canceled: the unlock dialog, or a prompt (or the connect itself).
 */
export function toastConnectCanceled(
  name: string,
  after: "unlock" | "prompt",
  next: ConnectCanceledNextStep
): void {
  const locked = after === "unlock" && next.typePasswordInstead !== undefined;
  const onClick = locked && next.typePasswordInstead ? next.typePasswordInstead : next.retry;
  // toast-policy: explains-outcome — the canceled dialog is gone and no tab opens; this names
  // the connect that stopped and offers the next step (#5838, #5881).
  toast.info(locked ? connectCanceledLockedText(name) : connectCanceledText(name), {
    testId: CONNECT_CANCELED_TOAST_TEST_ID,
    action: {
      label: locked ? CONNECT_CANCELED_TYPE_PASSWORD_LABEL : CONNECT_CANCELED_RETRY_LABEL,
      testId: CONNECT_CANCELED_ACTION_TEST_ID,
      onClick,
    },
  });
}
