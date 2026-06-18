import { describe, it, expect, vi } from "vitest";
import { InAppBridgeDriver, BridgeError, inProcessTransport } from "./driver";
import type { BridgeCommand, BridgeResponse } from "./protocol";

/** A transport that records commands and replies from a scripted table. */
function scriptedTransport(replies: Partial<Record<BridgeCommand["action"], BridgeResponse>>) {
  const sent: BridgeCommand[] = [];
  const transport = (command: BridgeCommand): BridgeResponse => {
    sent.push(command);
    return replies[command.action] ?? { ok: true, action: command.action };
  };
  return { transport, sent };
}

describe("InAppBridgeDriver", () => {
  it("maps click to a click command", async () => {
    const { transport, sent } = scriptedTransport({});
    await new InAppBridgeDriver(transport).click("save");
    expect(sent).toEqual([{ action: "click", testId: "save" }]);
  });

  it("maps type to a type command", async () => {
    const { transport, sent } = scriptedTransport({});
    await new InAppBridgeDriver(transport).type("host", "example.com");
    expect(sent).toEqual([{ action: "type", testId: "host", text: "example.com" }]);
  });

  it("maps terminalInput to a terminalInput command, defaulting to the active tab", async () => {
    const { transport, sent } = scriptedTransport({});
    await new InAppBridgeDriver(transport).terminalInput("ls");
    expect(sent).toEqual([{ action: "terminalInput", text: "ls", tabId: undefined }]);
  });

  it("maps terminalInput tabId option through", async () => {
    const { transport, sent } = scriptedTransport({});
    await new InAppBridgeDriver(transport).terminalInput("whoami", { tabId: "tab-9" });
    expect(sent).toEqual([{ action: "terminalInput", text: "whoami", tabId: "tab-9" }]);
  });

  it("maps contextMenu to a contextMenu command", async () => {
    const { transport, sent } = scriptedTransport({});
    await new InAppBridgeDriver(transport).contextMenu("connection-item-1");
    expect(sent).toEqual([{ action: "contextMenu", testId: "connection-item-1" }]);
  });

  it("maps selectOption to a selectOption command", async () => {
    const { transport, sent } = scriptedTransport({});
    await new InAppBridgeDriver(transport).selectOption("type", "ssh");
    expect(sent).toEqual([{ action: "selectOption", testId: "type", value: "ssh" }]);
  });

  it("maps pressKey to a pressKey command, defaulting testId to undefined", async () => {
    const { transport, sent } = scriptedTransport({});
    await new InAppBridgeDriver(transport).pressKey("Escape");
    expect(sent).toEqual([{ action: "pressKey", key: "Escape", testId: undefined }]);
  });

  it("maps pressKey with an explicit testId through", async () => {
    const { transport, sent } = scriptedTransport({});
    await new InAppBridgeDriver(transport).pressKey("Enter", "field");
    expect(sent).toEqual([{ action: "pressKey", key: "Enter", testId: "field" }]);
  });

  it("unwraps the value of a query command", async () => {
    const { transport } = scriptedTransport({
      getText: { ok: true, action: "getText", value: "Connected" },
    });
    const text = await new InAppBridgeDriver(transport).getText("status");
    expect(text).toBe("Connected");
  });

  it("passes readTerminal options through", async () => {
    const { transport, sent } = scriptedTransport({
      readTerminal: { ok: true, action: "readTerminal", value: "out\n" },
    });
    const out = await new InAppBridgeDriver(transport).readTerminal({
      tabId: "tab-3",
      joinFullWidthRows: true,
    });
    expect(out).toBe("out\n");
    expect(sent[0]).toEqual({
      action: "readTerminal",
      tabId: "tab-3",
      joinFullWidthRows: true,
    });
  });

  it("rejects with a BridgeError carrying the message on failure", async () => {
    const { transport } = scriptedTransport({
      click: { ok: false, action: "click", error: 'no element with data-testid="ghost"' },
    });
    const driver = new InAppBridgeDriver(transport);
    await expect(driver.click("ghost")).rejects.toBeInstanceOf(BridgeError);
    await expect(driver.click("ghost")).rejects.toThrow(/ghost/);
  });

  it("awaits an async transport", async () => {
    const transport = vi.fn(
      async (c: BridgeCommand): Promise<BridgeResponse> => ({
        ok: true,
        action: c.action,
        value: true,
      })
    );
    const exists = await new InAppBridgeDriver(transport).exists("x");
    expect(exists).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe("inProcessTransport", () => {
  it("dispatches via the installed window bridge", async () => {
    const dispatch = vi.fn(
      async (c: BridgeCommand): Promise<BridgeResponse> => ({
        ok: true,
        action: c.action,
        value: "ok",
      })
    );
    window.__termihubTestBridge = { ready: true, version: 1, dispatch };
    try {
      const res = await inProcessTransport({ action: "exists", testId: "x" });
      expect(res).toEqual({ ok: true, action: "exists", value: "ok" });
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      delete window.__termihubTestBridge;
    }
  });

  it("throws a helpful error when the bridge is absent", () => {
    delete window.__termihubTestBridge;
    expect(() => inProcessTransport({ action: "exists", testId: "x" })).toThrow(/test mode/);
  });
});
