/**
 * The zoom overlay is a real modal dialog (A11Y2-009, #4329).
 *
 * It used to be a plain `<div>` with a window-level capture listener that
 * swallowed every Escape — so vim/less/fzf in a zoomed terminal never saw it —
 * and Tab could walk into the hidden panels underneath. It is now built on the
 * shared `Modal`: labelled by the tab title, focus-trapped, closed by Escape
 * (but not when Escape belongs to a terminal or code editor inside it, where
 * Shift+Escape closes instead), and focus returns to where it was on close.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { clearOverrides, setOverride, unbindAction } from "@/services/keybindings";
import { ZoomOverlay } from "./ZoomOverlay";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let container: HTMLDivElement;
let root: Root;

const q = <T extends HTMLElement = HTMLElement>(testId: string) =>
  document.querySelector<T>(`[data-testid="${testId}"]`);

/** An opener outside the overlay plus the overlay, open while `open` is true. */
function Harness({ onClose, children }: { onClose?: () => void; children?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        Zoom
      </button>
      <button type="button" data-testid="outside">
        Behind the overlay
      </button>
      {open ? (
        <ZoomOverlay
          title="build-server"
          icon={<span data-testid="zoom-icon" />}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        >
          {children ?? (
            <>
              <button type="button" data-testid="inner-first">
                First
              </button>
              <button type="button" data-testid="inner-last">
                Last
              </button>
            </>
          )}
        </ZoomOverlay>
      ) : null}
    </>
  );
}

function openOverlay(children?: React.ReactNode, onClose?: () => void) {
  act(() => root.render(<Harness onClose={onClose}>{children}</Harness>));
  const opener = q<HTMLButtonElement>("opener")!;
  act(() => opener.focus());
  act(() => opener.click());
  return opener;
}

function keydown(target: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("ZoomOverlay — modal dialog semantics (#4329)", () => {
  it("is a modal dialog labelled by the zoomed tab's title", () => {
    openOverlay();
    const dialog = q("zoom-overlay")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("build-server");
  });

  it("moves focus into the dialog on open", () => {
    openOverlay();
    expect(q("zoom-overlay")!.contains(document.activeElement)).toBe(true);
  });

  it("traps focus: focusing content behind the overlay is pulled back inside", () => {
    openOverlay();
    act(() => q("outside")!.focus());
    expect(q("zoom-overlay")!.contains(document.activeElement)).toBe(true);
  });

  it("traps focus: Tab from the last element wraps to the first", () => {
    openOverlay();
    const last = q("inner-last")!;
    act(() => last.focus());
    keydown(last, { key: "Tab" });
    expect(q("zoom-overlay")!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
  });

  it("Escape closes it and focus returns to the opener", async () => {
    const onClose = vi.fn();
    const opener = openOverlay(undefined, onClose);
    keydown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(q("zoom-overlay")).toBeNull();
    await settle();
    expect(document.activeElement).toBe(opener);
  });

  it("the close button closes it", () => {
    const onClose = vi.fn();
    openOverlay(undefined, onClose);
    act(() => q("modal-close")!.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("leaves Escape to a focused terminal: it reaches xterm and does not close", () => {
    const onClose = vi.fn();
    const received = vi.fn();
    openOverlay(
      <div className="xterm">
        <textarea data-testid="xterm-input" onKeyDown={(e) => received(e.key)} />
      </div>,
      onClose
    );
    const input = q("xterm-input")!;
    act(() => input.focus());
    keydown(input, { key: "Escape" });
    expect(received).toHaveBeenCalledWith("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(q("zoom-overlay")).not.toBeNull();
  });

  it("leaves Escape to a focused Monaco editor too", () => {
    const onClose = vi.fn();
    openOverlay(
      <div className="monaco-editor">
        <textarea data-testid="monaco-input" />
      </div>,
      onClose
    );
    const input = q("monaco-input")!;
    act(() => input.focus());
    keydown(input, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Shift+Escape closes it from inside a terminal without sending Escape to it", () => {
    const onClose = vi.fn();
    const received = vi.fn();
    openOverlay(
      <div className="xterm">
        <textarea data-testid="xterm-input" onKeyDown={(e) => received(e.key)} />
      </div>,
      onClose
    );
    const input = q("xterm-input")!;
    act(() => input.focus());
    keydown(input, { key: "Escape", shiftKey: true });
    expect(onClose).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
  });

  it("states how to close it in the header hint", () => {
    openOverlay();
    expect(q("zoom-overlay-hint")?.textContent).toContain("Shift+Esc");
  });

  it("shows the effective zoom-panel binding in the hint (#4374)", () => {
    setOverride("zoom-panel", { key: "F7", alt: true });
    openOverlay();
    expect(q("zoom-overlay-hint")?.textContent).toBe("Shift+Esc or Alt+F7 to close");
    clearOverrides();
  });

  it("drops the binding from the hint when zoom-panel is unbound (#4374)", () => {
    unbindAction("zoom-panel");
    openOverlay();
    expect(q("zoom-overlay-hint")?.textContent).toBe("Shift+Esc to close");
    clearOverrides();
  });
});

describe("ZoomOverlay — menus open above the overlay (#4347)", () => {
  /** Read a `--z-*` token's numeric value from variables.css. */
  function zToken(name: string): number {
    const css = readFileSync(join(SRC_DIR, "styles", "variables.css"), "utf8");
    const m = new RegExp(`${name}\\s*:\\s*(\\d+)\\s*;`).exec(css);
    expect(m, `variables.css must define ${name}`).not.toBeNull();
    return Number(m![1]);
  }

  /** The `--z-*` token `.context-menu__content` stacks at. */
  function contextMenuZToken(): string {
    const css = readFileSync(join(SRC_DIR, "components", "Sidebar", "ConnectionList.css"), "utf8");
    const rule = /\.context-menu__content\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const z = /z-index\s*:\s*var\((--z-[a-z0-9-]+)\)/.exec(rule![1]);
    expect(z, ".context-menu__content must set a --z-* token").not.toBeNull();
    return z![1];
  }

  it("portals the title's right-click menu into the dialog, stacked above the scrim", async () => {
    act(() =>
      root.render(
        <ZoomOverlay
          title="build-server"
          icon={<span />}
          onClose={() => {}}
          menu={
            <ContextMenu.Item className="context-menu__item" data-testid="zoom-menu-item">
              Rename
            </ContextMenu.Item>
          }
        >
          <div>terminal</div>
        </ZoomOverlay>
      )
    );
    const label = document.querySelector<HTMLElement>(".zoom-overlay__label")!;
    expect(label).not.toBeNull();
    act(() => {
      label.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      );
    });
    await settle();

    const item = q("zoom-menu-item");
    expect(item, "the right-click menu should be open").not.toBeNull();
    const menu = item!.closest<HTMLElement>(".context-menu__content");
    expect(menu).not.toBeNull();
    // Inside the dialog: the modal's pointer-events lock leaves it clickable.
    expect(q("zoom-overlay")!.contains(menu)).toBe(true);
    // Its tier sits above the modal scrim and the modal surface.
    const tier = zToken(contextMenuZToken());
    expect(tier).toBeGreaterThan(zToken("--z-scrim"));
    expect(tier).toBeGreaterThan(zToken("--z-modal"));
  });
});
