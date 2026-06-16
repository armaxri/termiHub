import type { BridgeCommand, BridgeResponse } from "./protocol";
import type { BridgeTransport } from "./driver";
import {
  isResponseEnvelope,
  type BridgeRequestEnvelope,
  type BridgeResponseEnvelope,
} from "./wsProtocol";

/**
 * The runner's view of a single bidirectional message channel to the app.
 *
 * Keeping the transport's correlation logic behind this tiny interface (rather
 * than coupling it to a concrete `ws` socket) makes it pure and unit-testable —
 * the same dependency-injection seam the dispatcher uses. The `ws`-backed adapter
 * lives in `wsServer.ts`, so this module pulls in no Node-only dependency.
 */
export interface BridgeChannel {
  /** Send one serialized {@link BridgeRequestEnvelope} to the app. */
  send(data: string): void;
  /** Register the handler for incoming {@link BridgeResponseEnvelope} frames. */
  onMessage(listener: (data: string) => void): void;
  /** Register a handler invoked once when the channel closes. */
  onClose(listener: () => void): void;
  /** Close the channel. */
  close(): void;
}

/** Options for {@link WebSocketBridgeTransport}. */
export interface WebSocketBridgeTransportOptions {
  /**
   * Reject a command if no response arrives within this many ms (default 10000).
   * `0` disables the timeout — used in unit tests that drive the channel by hand.
   */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * A {@link BridgeTransport} that drives a remote app over a {@link BridgeChannel}.
 *
 * This is the runner-side end of the cross-platform transport (issue #801): the
 * app connects out over WebSocket and runs commands in-process, while this side
 * sends {@link BridgeRequestEnvelope}s and matches each
 * {@link BridgeResponseEnvelope} back to its pending promise by `id`. Pass
 * {@link transport} to an {@link InAppBridgeDriver} to drive the app exactly as
 * the in-process driver does — on every platform, with no automation driver.
 */
export class WebSocketBridgeTransport {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly channel: BridgeChannel,
    options: WebSocketBridgeTransportOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    channel.onMessage((data) => this.handleMessage(data));
    channel.onClose(() => this.failAll(new Error("bridge connection closed")));
  }

  /**
   * The {@link BridgeTransport} function, bound to this instance so it can be
   * handed straight to `new InAppBridgeDriver(transport.transport)`.
   */
  readonly transport: BridgeTransport = (command) => this.send(command);

  /** Send one command and resolve with its correlated {@link BridgeResponse}. */
  send(command: BridgeCommand): Promise<BridgeResponse> {
    if (this.closed) {
      return Promise.reject(new Error("bridge transport is closed"));
    }
    const id = this.nextId++;
    return new Promise<BridgeResponse>((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject };
      if (this.requestTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new Error(
              `bridge command "${command.action}" timed out after ${this.requestTimeoutMs}ms`
            )
          );
        }, this.requestTimeoutMs);
        // Don't keep a Node process alive purely for a pending bridge command.
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      const envelope: BridgeRequestEnvelope = { id, command };
      this.channel.send(JSON.stringify(envelope));
    });
  }

  /** Close the channel and reject any in-flight commands. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("bridge transport is closed"));
    this.channel.close();
  }

  private handleMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // not JSON — ignore
    }
    if (!isResponseEnvelope(parsed)) return;
    const { id, response } = parsed as BridgeResponseEnvelope;
    const entry = this.pending.get(id);
    if (!entry) return; // unknown / already-settled id
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(response);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
