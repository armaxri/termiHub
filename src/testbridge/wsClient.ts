import type { BridgeCommand, BridgeResponse } from "./protocol";
import { isRequestEnvelope, type BridgeResponseEnvelope } from "./wsProtocol";

/**
 * The cross-platform half of the test bridge that lives **inside the app**.
 *
 * In test mode, when the backend hands the webview a bridge port, the app opens a
 * WebSocket *out* to the runner's server, runs each incoming {@link BridgeCommand}
 * through the in-process dispatcher, and sends the {@link BridgeResponse} back.
 * Because the control surface is in-process and only the bytes travel over the
 * socket, the exact same path runs on Linux, Windows, and macOS — no platform
 * automation driver, so no macOS gap (ADR-5).
 */

/**
 * The subset of the browser `WebSocket` API the client relies on.
 *
 * Declaring it explicitly (rather than depending on the global `WebSocket`) keeps
 * the client dependency-injected and unit-testable with a fake, mirroring the
 * dispatcher's design.
 */
export interface BridgeClientSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "open" | "close" | "error", listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

/** Options for {@link runBridgeWebSocketClient}. */
export interface BridgeWebSocketClientOptions {
  /** The runner's WebSocket URL, e.g. `ws://127.0.0.1:<port>`. */
  url: string;
  /** Executes a command in-process; normally the live {@link dispatchCommand}. */
  dispatch: (command: BridgeCommand) => BridgeResponse | Promise<BridgeResponse>;
  /** Socket factory; defaults to the global `WebSocket`. Injected in tests. */
  createSocket?: (url: string) => BridgeClientSocket;
  /** Called once the socket opens (for logging). */
  onOpen?: () => void;
  /** Called when the socket closes (for logging). */
  onClose?: () => void;
  /** Called on a socket error (for logging). */
  onError?: (event: unknown) => void;
}

/** A handle to a running client; call {@link close} to tear it down. */
export interface BridgeWebSocketClient {
  /** Close the underlying socket and stop serving commands. */
  close(): void;
}

function defaultCreateSocket(url: string): BridgeClientSocket {
  return new WebSocket(url) as unknown as BridgeClientSocket;
}

/**
 * Connect to the runner and serve bridge commands over the socket until closed.
 *
 * Each frame is parsed as a {@link BridgeRequestEnvelope}; malformed or unrelated
 * frames are ignored. The command is dispatched (awaiting async transports), and
 * the result — or, if the dispatcher itself throws, a synthesised `ok: false`
 * response — is echoed back under the same `id`. Nothing thrown here escapes the
 * socket, preserving the bridge's "every failure is a response" contract.
 */
export function runBridgeWebSocketClient(
  options: BridgeWebSocketClientOptions
): BridgeWebSocketClient {
  const createSocket = options.createSocket ?? defaultCreateSocket;
  const socket = createSocket(options.url);

  socket.addEventListener("message", (event) => {
    void handleMessage(event.data);
  });
  if (options.onOpen) socket.addEventListener("open", () => options.onOpen?.());
  if (options.onClose) socket.addEventListener("close", () => options.onClose?.());
  if (options.onError) socket.addEventListener("error", (event) => options.onError?.(event));

  async function handleMessage(data: unknown): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return; // not JSON — not ours
    }
    if (!isRequestEnvelope(parsed)) return;

    let response: BridgeResponse;
    try {
      response = await options.dispatch(parsed.command);
    } catch (error) {
      response = {
        ok: false,
        action: parsed.command.action,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const envelope: BridgeResponseEnvelope = { id: parsed.id, response };
    socket.send(JSON.stringify(envelope));
  }

  return {
    close() {
      socket.close();
    },
  };
}
