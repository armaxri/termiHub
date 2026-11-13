import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";

const dismissTransient = vi.fn();
vi.mock("./Toast/toast", () => ({ toast: { dismissTransient: () => dismissTransient() } }));

import { Modal } from "./Modal";
import { TOAST_AVOID_ATTR } from "./Toast/toastAvoid";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function dialog(open: boolean, dismissTransientToasts?: boolean) {
  return (
    <Modal
      data-testid="modal"
      open={open}
      onOpenChange={() => {}}
      title="Connection failed"
      footer={<button type="button">Retry</button>}
      dismissTransientToasts={dismissTransientToasts}
    >
      <p>Body</p>
    </Modal>
  );
}

describe("Modal and toasts (#5618)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    dismissTransient.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("marks the whole open dialog as a toast keep-clear zone (#5686)", () => {
    render(dialog(true));
    const content = document.querySelector('[data-testid="modal"]');
    expect(content?.classList.contains("ui-modal")).toBe(true);
    expect(content?.hasAttribute(TOAST_AVOID_ATTR)).toBe(true);
  });

  it("marks its footer as a toast keep-clear zone", () => {
    render(dialog(true));
    const foot = document.querySelector(".ui-modal__foot");
    expect(foot?.hasAttribute(TOAST_AVOID_ATTR)).toBe(true);
  });

  it("clears stale success toasts once when an error dialog opens", () => {
    render(dialog(false, true));
    expect(dismissTransient).not.toHaveBeenCalled();
    render(dialog(true, true));
    expect(dismissTransient).toHaveBeenCalledTimes(1);
    render(dialog(true, true)); // a re-render while open does not clear again
    expect(dismissTransient).toHaveBeenCalledTimes(1);
  });

  it("leaves toasts alone for an ordinary dialog", () => {
    render(dialog(true));
    expect(dismissTransient).not.toHaveBeenCalled();
  });
});
