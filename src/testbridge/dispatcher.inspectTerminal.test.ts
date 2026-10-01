/**
 * The `inspectTerminal` bridge verb (#4013): the dispatcher routing, and the
 * real per-tab registries it reads through `inspectTerminal()`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import { inspectTerminal } from "./terminalInspection";
import type { TerminalInspection } from "./protocol";
import { CommandMarkTracker, OSC_133, registerCommandMarkTracker } from "@/services/commandMarks";
import {
  registerInlineImagesController,
  type InlineImagesController,
} from "@/components/Terminal/inlineImages";

/** Inert deps; `inspectTerminal` and the active tab come from the caller. */
function depsWith(overrides: Partial<BridgeDeps>): BridgeDeps {
  return {
    root: document,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "",
    emitEvent: async () => {},
    ...overrides,
  };
}

const INSPECTION: TerminalInspection = {
  commandMarks: { commands: [{ state: "finished", exitCode: 0 }], lastCommandOutput: "1" },
  inlineImages: { active: true, storageUsage: 0.5 },
};

describe("dispatchCommand inspectTerminal", () => {
  it("inspects the active terminal", async () => {
    const deps = depsWith({
      getActiveTabId: () => "tab-1",
      inspectTerminal: (tabId) => (tabId === "tab-1" ? INSPECTION : undefined),
    });
    const res = await dispatchCommand({ action: "inspectTerminal" }, deps);
    expect(res).toEqual({ ok: true, action: "inspectTerminal", value: INSPECTION });
  });

  it("inspects an explicit tabId", async () => {
    const deps = depsWith({
      inspectTerminal: (tabId) => (tabId === "tab-9" ? INSPECTION : undefined),
    });
    const res = await dispatchCommand({ action: "inspectTerminal", tabId: "tab-9" }, deps);
    expect(res.value).toEqual(INSPECTION);
  });

  it("fails when there is no active terminal", async () => {
    const deps = depsWith({ inspectTerminal: () => INSPECTION });
    const res = await dispatchCommand({ action: "inspectTerminal" }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no active terminal/);
  });

  it("fails when the requested terminal is not registered", async () => {
    const deps = depsWith({ inspectTerminal: () => undefined });
    const res = await dispatchCommand({ action: "inspectTerminal", tabId: "ghost" }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ghost");
  });

  it("fails clearly when inspection is not wired", async () => {
    const res = await dispatchCommand({ action: "inspectTerminal", tabId: "tab-1" }, depsWith({}));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not available/);
  });
});

describe("inspectTerminal (real registries)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  function fakeImages(active: boolean, usage: number): InlineImagesController {
    return {
      setEnabled: () => {},
      isActive: () => active,
      storageUsage: () => usage,
      dispose: () => {},
    };
  }

  it("is undefined for a tab with no terminal mounted", () => {
    expect(inspectTerminal("nothing-here")).toBeUndefined();
  });

  it("reports marks with exit codes and the copyable output from a real xterm", async () => {
    const term = new XTerm({ cols: 40, rows: 10, allowProposedApi: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    term.open(host);
    const tracker = new CommandMarkTracker(term);
    term.parser.registerOscHandler(OSC_133, tracker.handleOsc);
    cleanups.push(() => {
      tracker.dispose();
      term.dispose();
      host.remove();
    });
    cleanups.push(registerCommandMarkTracker("tab-marks", tracker));

    const m = (p: string) => `\x1b]133;${p}\x07`;
    await new Promise<void>((resolve) =>
      term.write(
        `${m("A")}$ ${m("B")}seq 2\r\n${m("C")}1\r\n2\r\n${m("D;0")}` +
          `${m("A")}$ ${m("B")}false\r\n${m("C")}${m("D;1")}${m("A")}$ `,
        resolve
      )
    );

    const inspection = inspectTerminal("tab-marks");
    expect(inspection?.commandMarks?.commands).toEqual([
      { state: "finished", exitCode: 0 },
      { state: "finished", exitCode: 1 },
      { state: "prompt", exitCode: null },
    ]);
    // `false` printed nothing, so there is nothing to copy.
    expect(inspection?.commandMarks?.lastCommandOutput).toBeNull();
    expect(inspection?.inlineImages).toBeNull();
  });

  it("reports the inline-image store of the tab", () => {
    cleanups.push(registerInlineImagesController("tab-img", fakeImages(true, 0.25)));
    expect(inspectTerminal("tab-img")).toEqual({
      commandMarks: null,
      inlineImages: { active: true, storageUsage: 0.25 },
    });
  });
});
