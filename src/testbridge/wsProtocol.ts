import type { BridgeCommand, BridgeResponse } from "./protocol";

/**
 * WebSocket framing for the cross-platform test-bridge transport.
 *
 * The in-process bridge ({@link BridgeCommand} → {@link BridgeResponse}) is a
 * one-shot call, but over a socket several commands may be in flight at once and
 * a {@link BridgeResponse} alone cannot say which request it answers (two `click`
 * commands produce two identical-looking `{ ok, action: "click" }` responses).
 *
 * So each message is wrapped in an envelope carrying a monotonically increasing
 * `id`. The runner ({@link WebSocketBridgeTransport}) sends
 * {@link BridgeRequestEnvelope}s and matches each {@link BridgeResponseEnvelope}
 * back to its pending promise by `id`; the app's WS client echoes the same `id`.
 */

/** A command sent from the runner to the app, tagged for correlation. */
export interface BridgeRequestEnvelope {
  /** Monotonic per-connection request id, echoed back in the response. */
  id: number;
  command: BridgeCommand;
}

/** The app's reply to a {@link BridgeRequestEnvelope}, carrying the same `id`. */
export interface BridgeResponseEnvelope {
  /** Mirrors the originating {@link BridgeRequestEnvelope.id}. */
  id: number;
  response: BridgeResponse;
}

/** Narrow an unknown parsed value to a {@link BridgeRequestEnvelope}. */
export function isRequestEnvelope(value: unknown): value is BridgeRequestEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "number" &&
    typeof candidate.command === "object" &&
    candidate.command !== null &&
    typeof (candidate.command as Record<string, unknown>).action === "string"
  );
}

/** Narrow an unknown parsed value to a {@link BridgeResponseEnvelope}. */
export function isResponseEnvelope(value: unknown): value is BridgeResponseEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "number" &&
    typeof candidate.response === "object" &&
    candidate.response !== null &&
    typeof (candidate.response as Record<string, unknown>).ok === "boolean"
  );
}

// ── Multi-window routing (TIN-014, #3720) ───────────────────────────────────
//
// Every native window is its own page with its own TestBridge, so each opens its
// own runner socket. The window names itself in the connection URL's query
// string (`ws://127.0.0.1:<port>/?window=<label>`), which the runner reads at the
// handshake — before any frame — so it can route commands to a specific window
// without a racy "hello" message. A connection with no `window` parameter (an
// older app build) is the main window, so single-window runners and tests are
// unaffected. The envelope format above is unchanged.

/** The window label a connection without a `window` parameter belongs to. */
export const DEFAULT_BRIDGE_WINDOW = "main";

/** Query parameter carrying the connecting window's runtime label. */
export const BRIDGE_WINDOW_QUERY_PARAM = "window";

/**
 * Accepted window labels: Tauri's own label alphabet (alphanumerics plus
 * `-`, `/`, `:`, `_`), capped in length. Anything else is rejected by the runner
 * rather than silently treated as the main window.
 */
const BRIDGE_WINDOW_LABEL_PATTERN = /^[A-Za-z0-9_:/-]{1,128}$/;

/** Whether `label` is an acceptable bridge window label. */
export function isValidBridgeWindowLabel(label: string): boolean {
  return BRIDGE_WINDOW_LABEL_PATTERN.test(label);
}

/**
 * The runner URL a window's in-app client dials: loopback only, tagged with the
 * window's label so the runner can address it (`driver.window(label)`).
 */
export function bridgeRunnerUrl(port: number, windowLabel: string): string {
  const label = isValidBridgeWindowLabel(windowLabel) ? windowLabel : DEFAULT_BRIDGE_WINDOW;
  return `ws://127.0.0.1:${port}/?${BRIDGE_WINDOW_QUERY_PARAM}=${encodeURIComponent(label)}`;
}

/**
 * The window label a runner-side connection belongs to, from the request path
 * the client dialled (e.g. `/?window=win-1`). Returns {@link DEFAULT_BRIDGE_WINDOW}
 * when the parameter is absent (legacy single-window client) and `null` when it
 * is present but not a valid label — the runner then refuses the connection.
 */
export function bridgeWindowFromRequestPath(path: string | undefined): string | null {
  const query = (path ?? "").split("?", 2)[1] ?? "";
  const params = new URLSearchParams(query);
  if (!params.has(BRIDGE_WINDOW_QUERY_PARAM)) return DEFAULT_BRIDGE_WINDOW;
  const label = params.get(BRIDGE_WINDOW_QUERY_PARAM) ?? "";
  return isValidBridgeWindowLabel(label) ? label : null;
}
