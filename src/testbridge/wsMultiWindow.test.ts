// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { serveWebSocketBridge, type WebSocketBridgeServer } from "./wsServer";
import { runBridgeWebSocketClient, type BridgeWebSocketClient } from "./wsClient";
import { InAppBridgeDriver } from "./driver";
import type { BridgeCommand, BridgeResponse } from "./protocol";
import {
  bridgeRunnerUrl,
  bridgeWindowFromRequestPath,
  DEFAULT_BRIDGE_WINDOW,
  isValidBridgeWindowLabel,
} from "./wsProtocol";

/**
 * Multi-window routing for the WebSocket bridge (TIN-014, #3720): every native
 * window dials its own runner socket tagged with its label, the runner can
 * address each window, and a secondary window never disturbs the main-window
 * connection single-window tests rely on.
 */

describe("bridge window URL helpers", () => {
  it("tags the runner URL with the window label, loopback only", () => {
    expect(bridgeRunnerUrl(4321, "win-2")).toBe("ws://127.0.0.1:4321/?window=win-2");
    expect(bridgeRunnerUrl(4321, "main")).toBe("ws://127.0.0.1:4321/?window=main");
  });

  it("falls back to the main window for an unusable label", () => {
    expect(bridgeRunnerUrl(4321, "")).toBe("ws://127.0.0.1:4321/?window=main");
    expect(bridgeRunnerUrl(4321, "bad label!")).toBe("ws://127.0.0.1:4321/?window=main");
  });

  it("reads the label back from the request path", () => {
    expect(bridgeWindowFromRequestPath("/?window=win-1")).toBe("win-1");
    expect(bridgeWindowFromRequestPath("/?window=main")).toBe("main");
    expect(bridgeWindowFromRequestPath("/?other=1&window=a%3Ab")).toBe("a:b");
  });

  it("treats an untagged (legacy) connection as the main window", () => {
    expect(bridgeWindowFromRequestPath("/")).toBe(DEFAULT_BRIDGE_WINDOW);
    expect(bridgeWindowFromRequestPath("")).toBe(DEFAULT_BRIDGE_WINDOW);
    expect(bridgeWindowFromRequestPath(undefined)).toBe(DEFAULT_BRIDGE_WINDOW);
  });

  it("rejects a present but malformed label", () => {
    expect(bridgeWindowFromRequestPath("/?window=")).toBeNull();
    expect(bridgeWindowFromRequestPath("/?window=has%20space")).toBeNull();
    expect(bridgeWindowFromRequestPath(`/?window=${"x".repeat(129)}`)).toBeNull();
  });

  it("accepts Tauri's label alphabet only", () => {
    expect(isValidBridgeWindowLabel("win-12")).toBe(true);
    expect(isValidBridgeWindowLabel("a/b:c_d")).toBe(true);
    expect(isValidBridgeWindowLabel("<script>")).toBe(false);
  });
});

describe("WebSocket bridge multi-window routing", () => {
  let server: WebSocketBridgeServer | undefined;
  const clients: BridgeWebSocketClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server?.close();
    server = undefined;
  });

  /** A stand-in window whose `getText` answers with its own label. */
  function dispatchFor(label: string) {
    return (command: BridgeCommand): BridgeResponse =>
      command.action === "getText"
        ? { ok: true, action: "getText", value: `${label}:${command.testId}` }
        : { ok: true, action: command.action };
  }

  function connectWindow(label: string, url?: string): BridgeWebSocketClient {
    const client = runBridgeWebSocketClient({
      url: url ?? bridgeRunnerUrl(server!.port, label),
      dispatch: dispatchFor(label),
    });
    clients.push(client);
    return client;
  }

  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !predicate(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(predicate()).toBe(true);
  }

  it("addresses each window separately", async () => {
    server = await serveWebSocketBridge();
    connectWindow("main");
    connectWindow("win-1");

    const main = new InAppBridgeDriver((await server.waitForApp()).transport);
    const second = new InAppBridgeDriver((await server.waitForWindow("win-1")).transport);

    await expect(main.getText("x")).resolves.toBe("main:x");
    await expect(second.getText("x")).resolves.toBe("win-1:x");
    expect(server.windows()).toEqual(["main", "win-1"]);
  });

  it("never lets a secondary window supersede the main connection", async () => {
    server = await serveWebSocketBridge();
    connectWindow("main");
    const main = await server.waitForApp();

    connectWindow("win-1");
    await server.waitForWindow("win-1");

    // waitForApp still hands out the main window, and it still answers.
    expect(await server.waitForApp()).toBe(main);
    await expect(new InAppBridgeDriver(main.transport).getText("y")).resolves.toBe("main:y");
  });

  it("keeps an untagged (legacy) client as the main window", async () => {
    server = await serveWebSocketBridge();
    connectWindow("main", `ws://127.0.0.1:${server.port}`);
    const driver = new InAppBridgeDriver((await server.waitForApp()).transport);
    await expect(driver.getText("z")).resolves.toBe("main:z");
    expect(server.windows()).toEqual(["main"]);
  });

  it("waits for a window that has not connected yet", async () => {
    server = await serveWebSocketBridge();
    const pending = server.waitForWindow("win-3");
    connectWindow("win-3");
    const driver = new InAppBridgeDriver((await pending).transport);
    await expect(driver.getText("q")).resolves.toBe("win-3:q");
  });

  it("drops a window from the list once its socket closes", async () => {
    server = await serveWebSocketBridge();
    connectWindow("main");
    const second = connectWindow("win-1");
    await server.waitForWindow("win-1");
    await server.waitForApp();

    second.close();
    await until(() => !server!.windows().includes("win-1"));
    expect(server.windows()).toEqual(["main"]);
  });

  it("refuses a connection with a malformed window label", async () => {
    server = await serveWebSocketBridge();
    connectWindow("bogus", `ws://127.0.0.1:${server.port}/?window=bad%20label`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.windows()).toEqual([]);
  });
});
