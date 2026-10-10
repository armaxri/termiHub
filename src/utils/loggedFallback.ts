import { errorMessage } from "@/utils/errorMessage";
import { frontendLog, frontendWarn } from "@/utils/frontendLog";

/**
 * Resolve `promise`, or `fallback` when it rejects — leaving a Log Viewer trace
 * of the rejection instead of the silent `.catch(() => null)` it replaces (#4520).
 *
 * Use it where a failed read degrades to a safe default (an empty list, "no
 * status") and the caller must keep going. The fallback alone makes a failure
 * look identical to "nothing there"; the log is what tells the two apart.
 *
 * @param promise  the operation whose failure degrades to `fallback`
 * @param fallback the value to resolve with on rejection
 * @param target   Log Viewer target (e.g. `"open_connections"`)
 * @param reason   short phrase naming what failed (e.g. `"read X server status"`)
 * @param level    `"warn"` (default) or `"debug"` for expected, noisy failures
 */
export async function withLoggedFallback<T, F>(
  promise: Promise<T>,
  fallback: F,
  target: string,
  reason: string,
  level: "warn" | "debug" = "warn"
): Promise<T | F> {
  try {
    return await promise;
  } catch (err) {
    const log = level === "debug" ? frontendLog : frontendWarn;
    log(target, `Failed to ${reason}: ${errorMessage(err)}`);
    return fallback;
  }
}
