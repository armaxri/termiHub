import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Select } from "@/components/ui";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";

/**
 * The bridge `select` verb must drive the design-system {@link Select} (a Radix
 * Select skin) as well as native `<select>`: its testid lands on the button
 * trigger, so the dispatcher opens the listbox and clicks the option whose
 * `data-value` matches, and `getValue` reads the trigger's mirrored `data-value`.
 */
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function deps(): BridgeDeps {
  return {
    root: document.body, // Radix renders its content in a portal under <body>
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "data:image/png;base64,AAAA",
    emitEvent: async () => {},
  };
}

const OPTIONS = [
  { value: "local", label: "Local Shell" },
  { value: "ssh", label: "SSH" },
  { value: "serial", label: "Serial" },
];

describe("dispatchCommand getValue against the Select primitive", () => {
  it("reads the mirrored data-value from the trigger", async () => {
    act(() => {
      root.render(<Select data-testid="sel" value="ssh" onChange={() => {}} options={OPTIONS} />);
    });

    const res = await dispatchCommand({ action: "getValue", testId: "sel" }, deps());
    expect(res).toEqual({ ok: true, action: "getValue", value: "ssh" });
  });
});

describe("dispatchCommand select against the Select primitive", () => {
  it("opens the listbox and picks the matching option", async () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<Select data-testid="sel" value="local" onChange={onChange} options={OPTIONS} />);
    });

    // Radix mounts the listbox in a layout effect that flushes at the end of
    // `act`, so a single synchronous dispatch opens + locates the option but the
    // option's handlers may bind a tick later — retrying (as the live harness's
    // `wait(select)` does) converges. In a real WebView one call suffices.
    for (let i = 0; i < 3 && onChange.mock.calls.length === 0; i++) {
      await act(async () => {
        await dispatchCommand({ action: "select", testId: "sel", value: "serial" }, deps());
      });
    }

    expect(onChange).toHaveBeenCalledWith("serial");
  });

  it("waits for a late-mounting listbox option (single call, no retry)", async () => {
    // Regression for the guided-manual harness (issue: guided-manual Radix
    // select): the Python bridge's `select` fires exactly one call with no
    // retry, and Radix portals its listbox asynchronously, so the dispatcher
    // must itself wait for the option to mount rather than checking once and
    // failing. Simulate the async portal mount deterministically: the trigger
    // carries the `ui-select__trigger` marker, and the matching option is
    // appended a task later (as the real portal does) in response to the
    // open keystroke. A single dispatch must still locate and click it.
    const trigger = document.createElement("button");
    trigger.setAttribute("data-testid", "sel");
    trigger.className = "ui-select__trigger";
    document.body.appendChild(trigger);

    const clicked = vi.fn();
    trigger.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Enter") return;
      setTimeout(() => {
        const opt = document.createElement("div");
        opt.className = "ui-select__item";
        opt.setAttribute("data-value", "serial");
        opt.addEventListener("click", () => clicked());
        document.body.appendChild(opt);
      }, 0);
    });

    const res = await dispatchCommand({ action: "select", testId: "sel", value: "serial" }, deps());

    expect(res.ok).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    trigger.remove();
    document.querySelector('.ui-select__item[data-value="serial"]')?.remove();
  });

  it("still resolves when requestAnimationFrame is paused (occluded WebView)", async () => {
    // Regression for #2460: a real WKWebView *has* rAF but throttles or fully
    // pauses it when its window is occluded/backgrounded (aggravated by
    // concurrent build load). The `select` verb polls the portal mount via
    // `nextFrame`, so an rAF-only yield stalls with no frames delivered and the
    // command hangs until the bridge's 10s timeout — the reported symptom. With
    // the wall-clock fallback in `nextFrame`, a single dispatch must still locate
    // and click a late-mounting option even while rAF never fires.
    const realRaf = globalThis.requestAnimationFrame;
    // Paused rAF: registers callbacks but never invokes them.
    globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
    try {
      const trigger = document.createElement("button");
      trigger.setAttribute("data-testid", "sel");
      trigger.className = "ui-select__trigger";
      document.body.appendChild(trigger);

      const clicked = vi.fn();
      trigger.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key !== "Enter") return;
        setTimeout(() => {
          const opt = document.createElement("div");
          opt.className = "ui-select__item";
          opt.setAttribute("data-value", "serial");
          opt.addEventListener("click", () => clicked());
          document.body.appendChild(opt);
        }, 0);
      });

      const res = await dispatchCommand(
        { action: "select", testId: "sel", value: "serial" },
        deps()
      );

      expect(res.ok).toBe(true);
      expect(clicked).toHaveBeenCalledTimes(1);
      trigger.remove();
      document.querySelector('.ui-select__item[data-value="serial"]')?.remove();
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
  });

  it("reports an error when the requested option is absent", async () => {
    act(() => {
      root.render(<Select data-testid="sel" value="local" onChange={() => {}} options={OPTIONS} />);
    });

    const res = await dispatchCommand({ action: "select", testId: "sel", value: "telnet" }, deps());
    expect(res.ok).toBe(false);
  });
});
