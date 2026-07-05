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
  // Radix Select probes pointer-capture APIs that jsdom omits.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
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

  it("reports an error when the requested option is absent", async () => {
    act(() => {
      root.render(<Select data-testid="sel" value="local" onChange={() => {}} options={OPTIONS} />);
    });

    const res = await dispatchCommand({ action: "select", testId: "sel", value: "telnet" }, deps());
    expect(res.ok).toBe(false);
  });
});
