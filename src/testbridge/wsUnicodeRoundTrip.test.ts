// @vitest-environment node
/**
 * Unicode wire round-trip over the REAL WebSocket bridge (I18N-016).
 *
 * Extends {@link ./wsRoundTrip.test.ts}: the runner's `ws` server talks to the
 * in-app client over a real socket, so every command/response is JSON-framed
 * across the wire exactly as it is inside the webview. This proves the JSON
 * serialization on both directions preserves CJK / RTL / combining / astral
 * text — the request text the driver sends, and the string value a response
 * carries back — codepoint-exact.
 */
import { describe, it, expect, afterEach } from "vitest";
import { serveWebSocketBridge, type WebSocketBridgeServer } from "./wsServer";
import { runBridgeWebSocketClient, type BridgeWebSocketClient } from "./wsClient";
import { InAppBridgeDriver } from "./driver";
import type { BridgeCommand, BridgeResponse } from "./protocol";

const SAMPLES = [
  "你好世界",
  "日本語のテスト",
  "한국어 테스트",
  "مرحبا بالعالم",
  "שלום עולם",
  "café", // NFD: e + combining acute
  "👨‍👩‍👧", // ZWJ family
  "🇯🇵", // regional-indicator flag
  "👍🏽", // skin-tone modifier
  "value = قيمة 42\n行 🎉", // multiline bidi + emoji
];

describe("Unicode WebSocket bridge round-trip (I18N-016)", () => {
  let server: WebSocketBridgeServer | undefined;
  let client: BridgeWebSocketClient | undefined;
  /** Last `type` text the in-app client received off the wire. */
  let lastTyped: string | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    await server?.close();
    server = undefined;
    lastTyped = undefined;
  });

  /**
   * Echoing dispatcher: captures the exact `type` text received over the
   * socket, and echoes the requested `getText` testId straight back as its
   * value so the response direction is exercised too.
   */
  function stubDispatch(command: BridgeCommand): BridgeResponse {
    switch (command.action) {
      case "type":
        lastTyped = command.text;
        return { ok: true, action: "type" };
      case "getText":
        return { ok: true, action: "getText", value: command.testId };
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

  it("preserves Unicode text sent in a command (request direction)", async () => {
    const driver = await connect();
    for (const sample of SAMPLES) {
      await driver.type("field", sample);
      expect(lastTyped).toBe(sample);
      expect([...(lastTyped ?? "")]).toEqual([...sample]);
    }
  });

  it("preserves Unicode text returned in a response (response direction)", async () => {
    const driver = await connect();
    for (const sample of SAMPLES) {
      // The stub echoes the testId as the value, so a Unicode testId proves the
      // response string survives serialization back across the socket.
      await expect(driver.getText(sample)).resolves.toBe(sample);
    }
  });
});
