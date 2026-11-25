import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Call somebody who waits for terminal output (#6070). What they throw is logged and
 * goes no further: the caller delivers output, and xterm never writes again after an
 * exception in a write callback.
 */
export function callWaiter(waiter: () => void): void {
  try {
    waiter();
  } catch (err) {
    frontendLog("terminal_output", `a reader of the output failed: ${errorMessage(err)}`);
  }
}
