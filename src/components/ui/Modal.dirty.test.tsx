/**
 * Regression tests for UX2-004 (#4314): a Modal holding unsaved input must not
 * discard it on Escape, a scrim click, the X, or a footer Cancel. With `dirty`
 * set, every dismiss path asks first through the shared unsaved-changes dialog;
 * a clean Modal still closes immediately.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Modal, ModalClose } from "./Modal";
import { Button } from "./Button";
import { flushAsync } from "@/test/flushAsync";

let container: HTMLDivElement;
let root: Root;

async function render(ui: React.ReactElement) {
  await act(async () => {
    root.render(ui);
  });
  // Radix registers its outside-pointer listener on a timeout after mount.
  await flushAsync();
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function editor(dirty: boolean, onOpenChange: (open: boolean) => void) {
  return (
    <Modal
      data-testid="modal"
      open
      onOpenChange={onOpenChange}
      title="Edit"
      dirty={dirty}
      footer={
        <ModalClose>
          <Button variant="secondary" data-testid="footer-cancel">
            Cancel
          </Button>
        </ModalClose>
      }
    >
      <input data-testid="modal-input" type="text" />
    </Modal>
  );
}

function pressEscape() {
  const el = q("modal-input")!;
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
  });
}

function clickScrim() {
  const overlay = q("modal-overlay")!;
  act(() => {
    overlay.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
}

const dismissPaths: Array<[string, () => void]> = [
  ["Escape", pressEscape],
  ["scrim click", clickScrim],
  ["the X button", () => act(() => q("modal-close")!.click())],
  ["a footer Cancel", () => act(() => q("footer-cancel")!.click())],
];

describe("Modal — dirty dismiss guard (UX2-004)", () => {
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

  describe.each(dismissPaths)("%s", (_label, dismiss) => {
    it("asks before discarding when dirty", async () => {
      const onOpenChange = vi.fn();
      await render(editor(true, onOpenChange));
      dismiss();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(q("unsaved-changes-just-close")).not.toBeNull();
    });

    it("closes immediately when clean", async () => {
      const onOpenChange = vi.fn();
      await render(editor(false, onOpenChange));
      dismiss();
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(q("unsaved-changes-just-close")).toBeNull();
    });
  });

  it("Discard closes the editor", async () => {
    const onOpenChange = vi.fn();
    await render(editor(true, onOpenChange));
    act(() => q("modal-close")!.click());
    act(() => q("unsaved-changes-just-close")!.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Cancel on the prompt keeps the editor open", async () => {
    const onOpenChange = vi.fn();
    await render(editor(true, onOpenChange));
    act(() => q("modal-close")!.click());
    act(() => q("unsaved-changes-cancel")!.click());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(q("unsaved-changes-just-close")).toBeNull();
    expect(q("modal")).not.toBeNull();
  });

  it("Escape on the prompt dismisses only the prompt", async () => {
    const onOpenChange = vi.fn();
    await render(editor(true, onOpenChange));
    act(() => q("modal-close")!.click());
    const discard = q("unsaved-changes-just-close")!;
    act(() => {
      discard.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(q("unsaved-changes-just-close")).toBeNull();
    expect(q("modal")).not.toBeNull();
  });

  it("offers no save action, since the prompt cannot validate the form", async () => {
    await render(editor(true, vi.fn()));
    act(() => q("modal-close")!.click());
    expect(q("unsaved-changes-save-and-close")).toBeNull();
  });
});
