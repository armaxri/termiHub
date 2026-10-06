import { describe, it, expect, vi } from "vitest";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import type { BridgeCommand } from "./protocol";

/** Minimal deps: the stub verb touches nothing but its own dep. */
function deps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    root: document,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "data:image/png;base64,AAAA",
    emitEvent: async () => {},
    ...overrides,
  };
}

describe("stubNativeDialog (#4122)", () => {
  it("hands a save path to the injected dep", async () => {
    const stubNativeDialog = vi.fn(async () => {});
    const res = await dispatchCommand(
      { action: "stubNativeDialog", kind: "save", path: "/tmp/out.json" },
      deps({ stubNativeDialog })
    );
    expect(res).toEqual({ ok: true, action: "stubNativeDialog" });
    expect(stubNativeDialog).toHaveBeenCalledWith("save", "/tmp/out.json");
  });

  it("reads an absent path as a cancel", async () => {
    const stubNativeDialog = vi.fn(async () => {});
    const res = await dispatchCommand(
      { action: "stubNativeDialog", kind: "open" },
      deps({ stubNativeDialog })
    );
    expect(res.ok).toBe(true);
    expect(stubNativeDialog).toHaveBeenCalledWith("open", null);
  });

  it("rejects an unknown dialog kind without calling the dep", async () => {
    const stubNativeDialog = vi.fn(async () => {});
    const command = {
      action: "stubNativeDialog",
      kind: "message",
      path: "/tmp/x",
    } as unknown as BridgeCommand;
    const res = await dispatchCommand(command, deps({ stubNativeDialog }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"open" or "save"');
    expect(stubNativeDialog).not.toHaveBeenCalled();
  });

  it("fails cleanly when the dep is not wired (outside the harness)", async () => {
    const res = await dispatchCommand(
      { action: "stubNativeDialog", kind: "save", path: "/tmp/out.json" },
      deps()
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not available");
  });

  it("fails with the dep's error when the grant is refused", async () => {
    const stubNativeDialog = vi.fn(async () => {
      throw new Error("test bridge is not enabled");
    });
    const res = await dispatchCommand(
      { action: "stubNativeDialog", kind: "save", path: "/tmp/out.json" },
      deps({ stubNativeDialog })
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("test bridge is not enabled");
  });
});
