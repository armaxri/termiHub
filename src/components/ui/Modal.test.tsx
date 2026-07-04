import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Modal } from "./Modal";

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
