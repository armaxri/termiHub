import type { BridgeCommand, BridgeResponse } from "./protocol";

/**
 * The in-process entry point the {@link TestBridge} installs on `window` when
 * test mode is active. External drivers reach it via `browser.execute(...)`
 * (WebDriver) or a backend-hosted control channel (macOS), then call
 * `dispatch` with a {@link BridgeCommand}.
 */
export interface TermihubTestBridge {
  /** Marker a runner can poll to confirm the bridge is mounted and ready. */
  ready: true;
  /** Protocol revision, so a runner can detect capability mismatches. */
  version: number;
  /** Execute a single command and return its structured response. */
  dispatch: (command: BridgeCommand) => BridgeResponse;
}

declare global {
  interface Window {
    __termihubTestBridge?: TermihubTestBridge;
  }
}

export {};
