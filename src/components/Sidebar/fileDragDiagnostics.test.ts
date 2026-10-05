import { describe, it, expect, afterEach, vi } from "vitest";

const durable = vi.fn();
vi.mock("@/utils/frontendLog", () => ({
  frontendDurableInfo: (...args: unknown[]) => durable(...args),
}));

import {
  CANCEL_SIGNAL_WINDOW_MS,
  CancelSignalRecorder,
  describePointerEvent,
  logFileDrag,
} from "./fileDragDiagnostics";

describe("logFileDrag", () => {
  afterEach(() => durable.mockReset());

  it("writes the built message durably under the file_drag target", () => {
    logFileDrag(() => "start: active=file:/a");
    expect(durable).toHaveBeenCalledWith("file_drag", "start: active=file:/a");
  });

  it("never throws out of a dnd-kit handler when describing the event fails", () => {
    expect(() =>
      logFileDrag(() => {
        throw new Error("no delta");
      })
    ).not.toThrow();
    expect(durable).toHaveBeenCalledWith("file_drag", "(could not describe drag event: no delta)");
  });
});

describe("describePointerEvent", () => {
  it("reports the fields that decide PointerSensor activation", () => {
    const e = new PointerEvent("pointerdown", {
      pointerType: "mouse",
      button: 0,
      buttons: 1,
      isPrimary: true,
      clientX: 10.4,
      clientY: 20.6,
    });
    expect(describePointerEvent(e)).toBe(
      "type=pointerdown pointerType=mouse button=0 buttons=1 isPrimary=true trusted=false at=(10,21)"
    );
  });

  it("handles a missing event", () => {
    expect(describePointerEvent(null)).toBe("event=none");
  });
});

describe("CancelSignalRecorder", () => {
  let recorder: CancelSignalRecorder | null = null;
  afterEach(() => recorder?.detach());

  function attached(now: () => number = () => 0) {
    recorder = new CancelSignalRecorder(now);
    recorder.attach(window);
    return recorder;
  }

  it("blames a window resize (dnd-kit cancels a pointer drag on resize)", () => {
    const r = attached();
    window.dispatchEvent(new Event("resize"));
    expect(r.takeReason()).toMatch(/^resize \(viewport=\d+x\d+\)$/);
  });

  it("blames a visibilitychange with the visibility state", () => {
    const r = attached();
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    expect(r.takeReason()).toMatch(/^visibilitychange \(visibilityState=\w+\)$/);
  });

  it("blames pointercancel and Escape", () => {
    const r = attached();
    document.dispatchEvent(new Event("pointercancel"));
    expect(r.takeReason()).toBe("pointercancel");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(r.takeReason()).toBe("escape");
  });

  it("keeps the drag-out cause over the synthetic visibilitychange it fires", () => {
    const r = attached();
    r.note("drag-out", "native OS drag took over");
    window.dispatchEvent(new Event("visibilitychange"));
    expect(r.takeReason()).toBe("drag-out (native OS drag took over)");
  });

  it("does not blame a stale signal, and consumes a reason once", () => {
    let t = 0;
    const r = attached(() => t);
    window.dispatchEvent(new Event("resize"));
    t = CANCEL_SIGNAL_WINDOW_MS + 1;
    expect(r.takeReason()).toMatch(/^unknown/);

    window.dispatchEvent(new Event("resize"));
    expect(r.takeReason()).toMatch(/^resize/);
    expect(r.takeReason()).toMatch(/^unknown/);
  });

  it("stops listening once detached", () => {
    const r = attached();
    r.detach();
    window.dispatchEvent(new Event("resize"));
    expect(r.takeReason()).toMatch(/^unknown/);
  });
});
