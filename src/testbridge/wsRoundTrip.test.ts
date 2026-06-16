// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { serveWebSocketBridge, type WebSocketBridgeServer } from "./wsServer";
import { runBridgeWebSocketClient, type BridgeWebSocketClient } from "./wsClient";
import { InAppBridgeDriver } from "./driver";
import type { BridgeCommand, BridgeResponse } from "./protocol";

/**
 * Full-path proof that a {@link Driver} can drive a remote app over WebSocket:
 * the runner's `ws` server ({@link serveWebSocketBridge}) talks to the in-app
 * client ({@link runBridgeWebSocketClient}) — driven here by Node's global
 * `WebSocket` — exactly as it would inside the webview. The same path runs on
 * every OS, which is the whole point of issue #801.
 */
describe("WebSocket bridge round-trip", () => {
  let server: WebSocketBridgeServer | undefined;
  let client: BridgeWebSocketClient | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    await server?.close();
    server = undefined;
  });

  /** Stand-in for the in-app dispatcher: echoes deterministic responses. */
  function stubDispatch(command: BridgeCommand): BridgeResponse {
    switch (command.action) {
      case "getText":
        return { ok: true, action: "getText", value: `text:${command.testId}` };
      case "readTerminal":
        return { ok: true, action: "readTerminal", value: "HELLO_MARKER\n" };
      case "click":
        return { ok: false, action: "click", error: `no element "${command.testId}"` };
      default:
        return { ok: true, action: command.action };
    }
  }

  async function connect() {
    server = await serveWebSocketBridge();
    client = runBridgeWebSocketClient({
      url: `ws://127.0.0.1:${server.port}`,
      dispatch: stubDispatch,
    });
    const transport = await server.waitForApp();
    return new InAppBridgeDriver(transport.transport);
  }

  it("reads a value back from the app through the driver", async () => {
    const driver = await connect();
    await expect(driver.getText("status")).resolves.toBe("text:status");
  });

  it("reconstructs terminal text over the socket", async () => {
    const driver = await connect();
    await expect(driver.readTerminal({ joinFullWidthRows: true })).resolves.toContain(
      "HELLO_MARKER"
    );
  });

  it("surfaces an ok:false response as a BridgeError", async () => {
    const driver = await connect();
    await expect(driver.click("ghost")).rejects.toThrow(/ghost/);
  });

  it("correlates many concurrent commands", async () => {
    const driver = await connect();
    const results = await Promise.all([
      driver.getText("a"),
      driver.getText("b"),
      driver.getText("c"),
    ]);
    expect(results).toEqual(["text:a", "text:b", "text:c"]);
  });

  it("drives a second app after the first disconnects (restart within one run)", async () => {
    // One runner session, one server: drive instance A, watch it disconnect,
    // then drive a freshly-launched instance B over the same server (issue #817).
    server = await serveWebSocketBridge();
    const url = `ws://127.0.0.1:${server.port}`;

    // Instance A connects, gets driven, then is "killed".
    const clientA = runBridgeWebSocketClient({ url, dispatch: stubDispatch });
    const transportA = await server.waitForApp();
    const driverA = new InAppBridgeDriver(transportA.transport);
    await expect(driverA.getText("a")).resolves.toBe("text:a");
    clientA.close();

    // Instance B (a fresh process) connects out to the same server; the runner
    // acquires a brand-new transport and drives it.
    const clientB = runBridgeWebSocketClient({ url, dispatch: stubDispatch });
    client = clientB; // tracked for afterEach teardown
    const transportB = await server.awaitNextApp();
    expect(transportB).not.toBe(transportA);
    const driverB = new InAppBridgeDriver(transportB.transport);
    await expect(driverB.getText("b")).resolves.toBe("text:b");
  });
});
