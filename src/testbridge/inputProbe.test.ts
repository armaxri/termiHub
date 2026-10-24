import { afterEach, describe, expect, it } from "vitest";

import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import {
  INPUT_PROBE_CAPACITY,
  armInputProbe,
  disarmInputProbe,
  inputProbeEvents,
} from "./inputProbe";
import type { OsInputProbeResult } from "./protocol";

function deps(root: ParentNode = document): BridgeDeps {
  return {
    root,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getTerminalInputElement: () => undefined,
    sendTerminalInput: async () => false,
    getState: () => ({}),
  } as unknown as BridgeDeps;
}

describe("inputProbe", () => {
  afterEach(() => {
    disarmInputProbe();
    document.body.innerHTML = "";
  });

  it("records key events with the target testid and modifier state", () => {
    document.body.innerHTML = `<div data-testid="pane"><input id="field" /></div>`;
    armInputProbe(document, true);
    const field = document.getElementById("field") as HTMLInputElement;
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "e", code: "KeyE", altKey: true, bubbles: true })
    );
    const [event] = inputProbeEvents();
    expect(event).toMatchObject({
      type: "keydown",
      key: "e",
      code: "KeyE",
      alt: true,
      ctrl: false,
      testId: "pane",
      // Synthetic: only OS-delivered events are trusted.
      isTrusted: false,
    });
  });

  it("records pointer coordinates", () => {
    armInputProbe(document, true);
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 12, clientY: 34, screenX: 112, screenY: 134 })
    );
    expect(inputProbeEvents()[0]).toMatchObject({
      type: "pointerdown",
      clientX: 12,
      clientY: 34,
      screenX: 112,
      screenY: 134,
    });
  });

  it("keeps only the most recent events and clears on reset", () => {
    armInputProbe(document, true);
    for (let i = 0; i < INPUT_PROBE_CAPACITY + 5; i++) {
      document.body.dispatchEvent(new KeyboardEvent("keyup", { key: String(i % 10) }));
    }
    expect(inputProbeEvents()).toHaveLength(INPUT_PROBE_CAPACITY);
    armInputProbe(document, true);
    expect(inputProbeEvents()).toHaveLength(0);
  });

  it("stops recording once disarmed", () => {
    armInputProbe(document, true);
    disarmInputProbe();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    expect(inputProbeEvents()).toEqual([]);
  });
});

describe("osInputProbe command", () => {
  afterEach(() => {
    disarmInputProbe();
    document.body.innerHTML = "";
  });

  it("arms the probe and returns geometry plus the element rect", async () => {
    document.body.innerHTML = `<div data-testid="target"></div>`;
    const target = document.querySelector("[data-testid=target]") as HTMLElement;
    target.getBoundingClientRect = () => new DOMRect(10, 20, 300, 40);

    const first = await dispatchCommand({ action: "osInputProbe", reset: true }, deps());
    expect(first.ok).toBe(true);
    expect((first.value as OsInputProbeResult).events).toEqual([]);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    const second = await dispatchCommand({ action: "osInputProbe", testId: "target" }, deps());
    const value = second.value as OsInputProbeResult;
    expect(value.rect).toEqual({ left: 10, top: 20, width: 300, height: 40 });
    expect(value.events.map((e) => e.key)).toEqual(["k"]);
    expect(value.devicePixelRatio).toBeGreaterThan(0);
    expect(typeof value.hasFocus).toBe("boolean");
  });

  it("fails on an unknown testid", async () => {
    const response = await dispatchCommand({ action: "osInputProbe", testId: "missing" }, deps());
    expect(response.ok).toBe(false);
    expect(response.error).toContain("missing");
  });
});
