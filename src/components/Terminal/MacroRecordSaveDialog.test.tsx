import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MacroRecordSaveDialog } from "./MacroRecordSaveDialog";
import { flushAsync } from "@/test/flushAsync";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function setInput(testid: string, value: string) {
  const input = document.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const baseProps = {
  open: true,
  stepCount: 3,
  onSave: () => {},
  onDiscard: () => {},
};

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** Render and let Radix register its outside-pointer listener (set on a timeout). */
async function renderSettled(ui: React.ReactElement) {
  await act(async () => {
    root.render(ui);
  });
  await flushAsync();
}

describe("MacroRecordSaveDialog", () => {
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

  it("renders nothing when closed", () => {
    render(<MacroRecordSaveDialog {...baseProps} open={false} />);
    expect(document.querySelector('[data-testid="macro-save-name"]')).toBeNull();
  });

  it("renders through the Modal primitive and shows the captured step count", () => {
    render(<MacroRecordSaveDialog {...baseProps} stepCount={5} />);
    expect(document.querySelector(".ui-modal")).toBeTruthy();
    expect(document.querySelector('[data-testid="macro-save-name"]')).toBeTruthy();
    expect(document.body.textContent).toContain("5");
  });

  it("disables Save until a name is entered", () => {
    render(<MacroRecordSaveDialog {...baseProps} />);
    const save = document.querySelector('[data-testid="macro-save-confirm"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    setInput("macro-save-name", "Deploy");
    expect(save.disabled).toBe(false);
  });

  it("Save fires onSave with trimmed name, description, and parsed tags", () => {
    const onSave = vi.fn();
    render(<MacroRecordSaveDialog {...baseProps} onSave={onSave} />);

    setInput("macro-save-name", "  Deploy  ");
    setInput("macro-save-description", "prod release");
    setInput("macro-save-tags", "ops, release ,, prod");

    act(() => {
      (document.querySelector('[data-testid="macro-save-confirm"]') as HTMLElement).click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      name: "Deploy",
      description: "prod release",
      tags: ["ops", "release", "prod"],
    });
  });

  it("omits an empty description", () => {
    const onSave = vi.fn();
    render(<MacroRecordSaveDialog {...baseProps} onSave={onSave} />);
    setInput("macro-save-name", "Bare");
    act(() => {
      (document.querySelector('[data-testid="macro-save-confirm"]') as HTMLElement).click();
    });
    expect(onSave).toHaveBeenCalledWith({ name: "Bare", description: undefined, tags: [] });
  });

  describe("dismissing keeps the recording (#5201)", () => {
    function pressEscape() {
      const el = q("macro-save-name")!;
      act(() => {
        el.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      });
    }

    function clickScrim() {
      act(() => {
        q("macro-save-dialog-overlay")!.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
        );
      });
    }

    const dismissPaths: Array<[string, () => void]> = [
      ["Escape", pressEscape],
      ["a scrim click", clickScrim],
      ["the X button", () => act(() => q("modal-close")!.click())],
      ["the Discard recording button", () => act(() => q("macro-save-discard")!.click())],
    ];

    describe.each(dismissPaths)("%s", (_label, dismiss) => {
      it("asks first and does not discard", async () => {
        const onDiscard = vi.fn();
        const onSave = vi.fn();
        await renderSettled(
          <MacroRecordSaveDialog {...baseProps} onDiscard={onDiscard} onSave={onSave} />
        );
        dismiss();
        expect(onDiscard).not.toHaveBeenCalled();
        expect(onSave).not.toHaveBeenCalled();
        expect(q("unsaved-changes-just-close")).not.toBeNull();
      });

      it("keeps the dialog and its entered name when the prompt is cancelled", async () => {
        const onDiscard = vi.fn();
        await renderSettled(<MacroRecordSaveDialog {...baseProps} onDiscard={onDiscard} />);
        setInput("macro-save-name", "Deploy");
        dismiss();
        act(() => q("unsaved-changes-cancel")!.click());
        expect(onDiscard).not.toHaveBeenCalled();
        expect(q("unsaved-changes-just-close")).toBeNull();
        expect((q("macro-save-name") as HTMLInputElement).value).toBe("Deploy");
      });

      it("discards only once the prompt is confirmed", async () => {
        const onDiscard = vi.fn();
        const onSave = vi.fn();
        await renderSettled(
          <MacroRecordSaveDialog {...baseProps} onDiscard={onDiscard} onSave={onSave} />
        );
        dismiss();
        act(() => q("unsaved-changes-just-close")!.click());
        expect(onDiscard).toHaveBeenCalledTimes(1);
        expect(onSave).not.toHaveBeenCalled();
      });

      it("discards directly when no step was captured", async () => {
        const onDiscard = vi.fn();
        await renderSettled(
          <MacroRecordSaveDialog {...baseProps} stepCount={0} onDiscard={onDiscard} />
        );
        dismiss();
        expect(onDiscard).toHaveBeenCalledTimes(1);
        expect(q("unsaved-changes-just-close")).toBeNull();
      });
    });

    it("Escape on the prompt returns to the dialog without discarding", async () => {
      const onDiscard = vi.fn();
      await renderSettled(<MacroRecordSaveDialog {...baseProps} onDiscard={onDiscard} />);
      pressEscape();
      act(() => {
        q("unsaved-changes-just-close")!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      });
      expect(onDiscard).not.toHaveBeenCalled();
      expect(q("unsaved-changes-just-close")).toBeNull();
      expect(q("macro-save-dialog")).not.toBeNull();
    });

    it("Enter in the prompt does not save the macro", async () => {
      const onSave = vi.fn();
      await renderSettled(<MacroRecordSaveDialog {...baseProps} onSave={onSave} />);
      setInput("macro-save-name", "Deploy");
      pressEscape();
      act(() => {
        q("unsaved-changes-cancel")!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
        );
      });
      expect(onSave).not.toHaveBeenCalled();
    });

    it("Enter in the name field still saves", async () => {
      const onSave = vi.fn();
      await renderSettled(<MacroRecordSaveDialog {...baseProps} onSave={onSave} />);
      setInput("macro-save-name", "Deploy");
      act(() => {
        q("macro-save-name")!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
        );
      });
      expect(onSave).toHaveBeenCalledWith({ name: "Deploy", description: undefined, tags: [] });
    });
  });
});
