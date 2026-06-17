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
   * Repeated calls return the same transport while the current app is connected;
   * after it disconnects, a subsequent call waits for the next app to connect.
   */
  waitForApp(): Promise<WebSocketBridgeTransport>;
  /**
   * Resolve with a fresh transport for the **next** app connection — one that
   * arrives after the connection last handed out by {@link waitForApp} /
   * {@link awaitNextApp}. If such a connection has already arrived, resolves
   * immediately. This is the kill/restart-within-one-run seam (issue #817):
   * after the current app disconnects, `awaitNextApp()` drives the next launch.
   */
  awaitNextApp(): Promise<WebSocketBridgeTransport>;
  /** Stop the server and reject any in-flight commands and pending waiters. */
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

  /** Waiter for a connection whose generation is at least {@link minGeneration}. */
  interface AppWaiter {
    minGeneration: number;
    resolve: (transport: WebSocketBridgeTransport) => void;
    reject: (error: Error) => void;
  }

  // A monotonic connection counter (the "generation"). It increments on every
  // accepted app connection so the runner can tell a restarted app apart from
  // the one it last drove. `current` is the live transport (undefined between an
  // app disconnecting and the next connecting), and stays paired with the
  // generation in `currentGeneration`; `handedOut` is the highest generation a
  // waitForApp/awaitNextApp call has resolved with. When `current` is set,
  // `currentGeneration` is always >= `handedOut`, so the two never need a max().
  let currentGeneration = 0;
  let current: WebSocketBridgeTransport | undefined;
  let handedOut = 0;
  const waiters: AppWaiter[] = [];

  /** Resolve every waiter whose threshold the current connection now satisfies. */
  function settleWaiters(): void {
    if (!current) return;
    let settled = false;
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (currentGeneration >= waiters[i].minGeneration) {
        waiters.splice(i, 1)[0].resolve(current);
        settled = true;
      }
    }
    if (settled) handedOut = currentGeneration;
  }

  /** Hand out the current connection if it satisfies `minGeneration`, else wait. */
  function acquire(minGeneration: number): Promise<WebSocketBridgeTransport> {
    if (current && currentGeneration >= minGeneration) {
      handedOut = currentGeneration;
      return Promise.resolve(current);
    }
    return new Promise<WebSocketBridgeTransport>((resolve, reject) => {
      waiters.push({ minGeneration, resolve, reject });
    });
  }

  server.on("connection", (socket) => {
    // Last writer wins: the newest connection becomes the live one and supersedes
    // any predecessor, so a single app drives the run at a time AND a restarted
    // app always re-acquires the bridge (issue #817). Rejecting an overlapping
    // connection instead would wedge a restart that races the old socket's close.
    currentGeneration += 1;
    const previous = current;
    const transport = new WebSocketBridgeTransport(channelFromSocket(socket), {
      requestTimeoutMs: options.requestTimeoutMs,
    });
    current = transport;
    // Drop any predecessor still around (e.g. a restart that beat its close).
    previous?.close();
    socket.on("close", () => {
      // Free the slot only if this is still the live connection — a supersede
      // already moved `current` on, and that newer connection must stay.
      if (current === transport) current = undefined;
    });
    settleWaiters();
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
        // The current app, or the next to connect once the previous has gone.
        waitForApp: () => acquire(currentGeneration),
        // Strictly the next connection after the one we last handed out.
        awaitNextApp: () => acquire(handedOut + 1),
        close: () =>
          new Promise<void>((res) => {
            const error = new Error("bridge server closed");
            for (const waiter of waiters.splice(0)) waiter.reject(error);
            current?.close();
            current = undefined;
            server.close(() => res());
          }),
      });
    });
  });
}
