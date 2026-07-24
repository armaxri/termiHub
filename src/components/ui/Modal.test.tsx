import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Modal, useModalPortalContainer } from "./Modal";

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
});
