import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  routeTerminalRightClick,
  shouldHoldBackRightClickReport,
  useTerminalRightClickRouting,
} from "./terminalRightClick";

// #3801: a right-click in a terminal whose app has enabled mouse reporting was
// handled twice — xterm forwarded it to the app as a mouse report (Claude Code
// pastes on right-click, conhost-style) AND termiHub's own quick action pasted.
// Convention (Windows Terminal, GNOME Terminal, iTerm2): with mouse reporting on,
// a plain right-click belongs to the app; Shift+right-click is the terminal's own.

describe("routeTerminalRightClick (#3801)", () => {
  it("routes to termiHub when the app has not enabled mouse reporting", () => {
    expect(routeTerminalRightClick(false, false)).toBe("termihub");
    expect(routeTerminalRightClick(false, true)).toBe("termihub");
  });

  it("routes a plain right-click to the app when mouse reporting is on", () => {
    expect(routeTerminalRightClick(true, false)).toBe("app");
  });

  it("routes Shift+right-click to termiHub even when mouse reporting is on", () => {
    expect(routeTerminalRightClick(true, true)).toBe("termihub");
  });
});

describe("shouldHoldBackRightClickReport (#3801)", () => {
  it("holds back only Shift+right-button presses while reporting is on", () => {
    expect(shouldHoldBackRightClickReport({ button: 2, shiftKey: true }, true)).toBe(true);
    expect(shouldHoldBackRightClickReport({ button: 2, shiftKey: false }, true)).toBe(false);
    expect(shouldHoldBackRightClickReport({ button: 0, shiftKey: true }, true)).toBe(false);
    expect(shouldHoldBackRightClickReport({ button: 2, shiftKey: true }, false)).toBe(false);
  });
});

// Component-level: a wrapper wired like SplitView's terminal trigger, with an
// inner element standing in for xterm's root. xterm encodes a mouse report from
// its own bubble-phase `mousedown` listener on that element, so "the report is
// forwarded" == "the inner mousedown listener runs".
let tracking = false;
const paste = vi.fn();
const xtermMouseDown = vi.fn();

function Harness() {
  const { onMouseDownCapture, claimRightClick } = useTerminalRightClickRouting(() => tracking);
  return (
    <div
      data-testid="trigger"
      onMouseDownCapture={(e) => onMouseDownCapture(e, "tab-1")}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!claimRightClick(e, "tab-1")) return;
        paste("tab-1");
      }}
    >
      <div
        data-testid="xterm"
        ref={(el) => {
          el?.addEventListener("mousedown", xtermMouseDown);
        }}
      />
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

function rightClick(shiftKey: boolean) {
  const target = container.querySelector('[data-testid="xterm"]') as HTMLElement;
  act(() => {
    target.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, shiftKey })
    );
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, shiftKey })
    );
  });
}

beforeEach(() => {
  tracking = false;
  paste.mockClear();
  xtermMouseDown.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useTerminalRightClickRouting (#3801)", () => {
  it("mouse reporting off: a right-click pastes once", () => {
    rightClick(false);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it("mouse reporting on: a right-click goes to the app only (no termiHub paste)", () => {
    tracking = true;
    rightClick(false);
    expect(paste).not.toHaveBeenCalled();
    expect(xtermMouseDown).toHaveBeenCalledTimes(1);
  });

  it("mouse reporting on: Shift+right-click pastes and is not forwarded to the app", () => {
    tracking = true;
    rightClick(true);
    expect(paste).toHaveBeenCalledTimes(1);
    expect(xtermMouseDown).not.toHaveBeenCalled();
  });

  it("mouse reporting off: Shift+right-click still pastes and reaches xterm normally", () => {
    rightClick(true);
    expect(paste).toHaveBeenCalledTimes(1);
    expect(xtermMouseDown).toHaveBeenCalledTimes(1);
  });
});
