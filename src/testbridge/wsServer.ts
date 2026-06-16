import { WebSocketServer, type WebSocket as WsSocket, type RawData } from "ws";
import { WebSocketBridgeTransport, type BridgeChannel } from "./wsTransport";

/**
 * `ws`-backed runner server for the cross-platform test bridge (issue #801).
 *
 * The runner hosts this server and passes its port to the app (via
 * `TERMIHUB_TEST_BRIDGE_PORT`); the app connects *out* to it. This module is the
 * only place that depends on the Node-only `ws` library, so the transport's
 * correlation logic (`wsTransport.ts`) and the in-app client (`wsClient.ts`) stay
 * free of it and run in the browser/jsdom.
 */

/** Options for {@link serveWebSocketBridge}. */
export interface ServeWebSocketBridgeOptions {
  /** Port to listen on; `0` (default) picks a free ephemeral port. */
  port?: number;
  /** Interface to bind; defaults to loopback only. */
  host?: string;
  /** Per-command response timeout passed to the {@link WebSocketBridgeTransport}. */
  requestTimeoutMs?: number;
}

/** A listening bridge server; await {@link waitForApp} once the app is launched. */
export interface WebSocketBridgeServer {
  /** The port the server is listening on (resolved before the app connects). */
  port: number;
  /**
   * Resolve with a {@link WebSocketBridgeTransport} once the app connects out.
   * Repeated calls return the same transport for the current connection.
   */
  waitForApp(): Promise<WebSocketBridgeTransport>;
  /** Stop the server and reject any in-flight commands. */
  close(): Promise<void>;
}

/** Adapt a `ws` socket to the transport's {@link BridgeChannel} seam. */
function channelFromSocket(socket: WsSocket): BridgeChannel {
  return {
    send: (data) => socket.send(data),
    onMessage: (listener) => socket.on("message", (raw: RawData) => listener(raw.toString())),
    onClose: (listener) => socket.on("close", () => listener()),
    close: () => socket.close(),
  };
}

/**
 * Start listening for the app's outbound WebSocket connection.
 *
 * Resolves once the server is listening so the caller can read {@link port} and
 * hand it to the app before launch; the {@link waitForApp} promise then resolves
 * when the app connects and a transport is ready to drive it.
 */
export function serveWebSocketBridge(
  options: ServeWebSocketBridgeOptions = {}
): Promise<WebSocketBridgeServer> {
  const host = options.host ?? "127.0.0.1";
  const server = new WebSocketServer({ port: options.port ?? 0, host });

  let resolveApp!: (transport: WebSocketBridgeTransport) => void;
  const appReady = new Promise<WebSocketBridgeTransport>((resolve) => {
    resolveApp = resolve;
  });
  let transport: WebSocketBridgeTransport | undefined;

  server.on("connection", (socket) => {
    // First connection wins; later ones are closed so a single app drives the run.
    if (transport) {
      socket.close();
      return;
    }
    transport = new WebSocketBridgeTransport(channelFromSocket(socket), {
      requestTimeoutMs: options.requestTimeoutMs,
    });
    resolveApp(transport);
  });

  return new Promise<WebSocketBridgeServer>((resolve, reject) => {
    server.on("error", reject);
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("WebSocket bridge server has no TCP address"));
        return;
      }
      resolve({
        port: address.port,
        waitForApp: () => appReady,
        close: () =>
          new Promise<void>((res) => {
            transport?.close();
            server.close(() => res());
          }),
      });
    });
  });
}
