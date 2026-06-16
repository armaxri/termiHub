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
