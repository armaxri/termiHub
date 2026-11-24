/**
 * Let sonner's toast-removal timers run out before a test file ends.
 *
 * When a toast is dismissed, sonner waits `TIME_BEFORE_UNMOUNT` (200 ms) in a
 * real `setTimeout` and then updates the toaster's state. If the file's last
 * test dismissed a toast less than 200 ms before the file ends, that timer fires
 * after jsdom has torn down `window`. React then throws "window is not defined"
 * as an unhandled error, and vitest fails the whole run although every test
 * passed. Call this from `afterAll` in files that mount the real toast host.
 */
import { act } from "react";

/** A little longer than sonner's 200 ms `TIME_BEFORE_UNMOUNT`. */
const SONNER_REMOVAL_GRACE_MS = 300;

/** Wait until every pending sonner removal timer has fired. */
export async function drainSonnerRemovalTimers(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SONNER_REMOVAL_GRACE_MS));
  });
}
