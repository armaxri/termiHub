import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Modal, useModalPortalContainer } from "./Modal";
import { resetImeCompositionTrackerForTests } from "../../utils/imeComposition";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("Modal", () => {
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

  it("does not render content when closed", () => {
    render(
      <Modal data-testid="modal" open={false} onOpenChange={() => {}} title="Delete connection">
        <p>Body</p>
      </Modal>
    );
    expect(document.querySelector('[data-testid="modal"]')).toBeNull();
  });

  it("renders content, title, and body into a portal when open", () => {
    render(
      <Modal data-testid="modal" open onOpenChange={() => {}} title="Delete connection">
        <p>Are you sure?</p>
      </Modal>
    );
    const content = document.querySelector('[data-testid="modal"]');
    expect(content).toBeTruthy();
    expect(content!.classList.contains("ui-modal")).toBe(true);
    expect(content!.textContent).toContain("Delete connection");
    expect(content!.textContent).toContain("Are you sure?");
  });

  it("derives a `<testid>-overlay` testid for the scrim (#4010)", () => {
    render(
      <Modal data-testid="modal" open onOpenChange={() => {}} title="Pick">
        <p>Body</p>
      </Modal>
    );
    expect(document.querySelector('[data-testid="modal-overlay"]')).not.toBeNull();
  });

  it("renders a footer when provided", () => {
    render(
      <Modal
        data-testid="modal"
        open
        onOpenChange={() => {}}
        title="Delete"
        footer={<button data-testid="modal-confirm">Delete</button>}
      >
        <p>Body</p>
      </Modal>
    );
    expect(document.querySelector('[data-testid="modal-confirm"]')).toBeTruthy();
  });

  it("applies the lg size class only when size='lg'", () => {
    render(
      <Modal data-testid="modal" open onOpenChange={() => {}} title="Wide" size="lg">
        <p>Body</p>
      </Modal>
    );
    expect(
      document.querySelector('[data-testid="modal"]')!.classList.contains("ui-modal--lg")
    ).toBe(true);
  });

  it("exposes its content node as a portal container to descendants (#1868)", () => {
    let received: HTMLElement | null = null;
    function Probe() {
      received = useModalPortalContainer();
      return null;
    }
    render(
      <Modal data-testid="modal" open onOpenChange={() => {}} title="Editor">
        <Probe />
      </Modal>
    );
    // Descendants must receive the dialog's content element so they can portal
    // menus/selects inside it (where pointer-events are enabled), not into
    // document.body (which the modal disables) — see #1868.
    const content = document.querySelector('[data-testid="modal"]');
    expect(received).toBe(content);
  });

  it("returns null from useModalPortalContainer outside any modal", () => {
    let received: HTMLElement | null = document.body;
    function Probe() {
      received = useModalPortalContainer();
      return null;
    }
    render(<Probe />);
    // No modal ancestor → null, so callers fall back to Radix's default body.
    expect(received).toBeNull();
  });

  it("calls onOpenChange(false) when the built-in close button is clicked", () => {
    const onOpenChange = vi.fn();
    render(
      <Modal data-testid="modal" open onOpenChange={onOpenChange} title="Delete">
        <p>Body</p>
      </Modal>
    );
    act(() => (document.querySelector('[data-testid="modal-close"]') as HTMLElement).click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  describe("IME composition (#3767)", () => {
    function openWithInput(onOpenChange: (open: boolean) => void): HTMLInputElement {
      render(
        <Modal data-testid="modal" open onOpenChange={onOpenChange} title="Rename">
          <input data-testid="modal-input" type="text" />
        </Modal>
      );
      return document.querySelector<HTMLInputElement>('[data-testid="modal-input"]')!;
    }

    function fire(el: HTMLElement, ev: Event) {
      act(() => {
        el.dispatchEvent(ev);
      });
    }

    function escape(isComposing: boolean, keyCode = 0): KeyboardEvent {
      return new KeyboardEvent("keydown", {
        key: "Escape",
        isComposing,
        keyCode,
        bubbles: true,
        cancelable: true,
      });
    }

    beforeEach(() => resetImeCompositionTrackerForTests());
    afterEach(() => resetImeCompositionTrackerForTests());

    it("Escape during composition keeps the dialog open", () => {
      const onOpenChange = vi.fn();
      const el = openWithInput(onOpenChange);
      fire(el, new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      fire(el, escape(true));
      fire(el, escape(false, 229));
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("Escape right after compositionend (WebKit order) keeps the dialog open", () => {
      const onOpenChange = vi.fn();
      const el = openWithInput(onOpenChange);
      fire(el, new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      fire(el, new CompositionEvent("compositionend", { data: "", bubbles: true }));
      fire(el, escape(false));
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("does not forward composition Enter keys to the onKeyDown handler", () => {
      const onKeyDown = vi.fn();
      render(
        <Modal
          data-testid="modal"
          open
          onOpenChange={() => {}}
          title="Rename"
          onKeyDown={onKeyDown}
        >
          <input data-testid="modal-input" type="text" />
        </Modal>
      );
      const el = document.querySelector<HTMLInputElement>('[data-testid="modal-input"]')!;
      const enter = (init: KeyboardEventInit) =>
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
      fire(el, new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      fire(el, enter({ isComposing: true }));
      fire(el, new CompositionEvent("compositionend", { data: "日本語", bubbles: true }));
      fire(el, enter({ keyCode: 229 }));
      expect(onKeyDown).not.toHaveBeenCalled();
      fire(el, enter({}));
      expect(onKeyDown).toHaveBeenCalledTimes(1);
    });

    it("a normal Escape still closes the dialog", () => {
      const onOpenChange = vi.fn();
      const el = openWithInput(onOpenChange);
      fire(el, escape(false));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
