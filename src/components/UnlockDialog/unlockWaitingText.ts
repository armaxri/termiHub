import { tf } from "@/i18n/catalog";
import type { UnlockWaiter } from "@/store/slices/credentialStoreSlice";

/** "prod-db (SSH)", or just "prod-db" when the connection type is unknown. */
function waiterTarget(waiter: UnlockWaiter): string {
  return waiter.transport
    ? tf("unlockDialog.waiting.target", { name: waiter.name, transport: waiter.transport })
    : waiter.name;
}

/**
 * The unlock dialog's line naming the connects waiting on it (#5684), or
 * `null` for a plain unlock with none waiting (the status-bar lock).
 *
 * One waiting connect is named with the secret it reads: "Unlock to connect
 * to prod-db (SSH) with its saved password." Several name the first and count
 * the rest: "… to prod-db (SSH) and 2 more connections with their saved
 * credentials."
 */
export function unlockWaitingText(waiters: readonly UnlockWaiter[]): string | null {
  const [first, ...rest] = waiters;
  if (!first) return null;
  const target = waiterTarget(first);
  if (rest.length === 0) {
    return first.secret === "passphrase"
      ? tf("unlockDialog.waiting.passphrase", { target })
      : tf("unlockDialog.waiting.password", { target });
  }
  return tf(
    rest.length === 1 ? "unlockDialog.waiting.many.one" : "unlockDialog.waiting.many.other",
    {
      target,
      count: rest.length,
    }
  );
}
