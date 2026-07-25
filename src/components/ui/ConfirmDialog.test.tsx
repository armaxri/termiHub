import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ConfirmDialog } from "./ConfirmDialog";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

/** The "don't ask again" control rendered in the dialog body. */
function dontAskAgain(): HTMLButtonElement {
  return document.querySelector(
    '[data-testid="confirm-dialog-dont-ask-again"]'
  ) as HTMLButtonElement;
}

describe("ConfirmDialog", () => {
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
    render(
      <ConfirmDialog open={false} title="T" message="M" onConfirm={vi.fn()} onCancel={vi.fn()} />
    );
    expect(document.querySelector('[data-testid="confirm-dialog-confirm"]')).toBeNull();
  });

  it("shows title, message, and custom labels", () => {
    render(
      <ConfirmDialog
        open
        title="Kill everything?"
        message="This stops 3 sessions."
        confirmLabel="Kill All"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        data-testid="my-confirm"
      />
    );
    const dialog = document.querySelector('[data-testid="my-confirm"]');
    expect(dialog?.textContent).toContain("Kill everything?");
    expect(dialog?.textContent).toContain("This stops 3 sessions.");
    expect(document.querySelector('[data-testid="confirm-dialog-confirm"]')?.textContent).toContain(
      "Kill All"
    );
  });

  it("fires onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="T" message="M" onConfirm={onConfirm} onCancel={vi.fn()} />);
    act(() => {
      (document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement).click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("fires onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="T" message="M" onConfirm={vi.fn()} onCancel={onCancel} />);
    act(() => {
      (document.querySelector('[data-testid="confirm-dialog-cancel"]') as HTMLElement).click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders a children body slot between the message and the action row", () => {
    render(
      <ConfirmDialog
        open
        title="Save host"
        message="Give it a name."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        data-testid="my-confirm"
      >
        <input data-testid="body-field" defaultValue="Office NAS" />
      </ConfirmDialog>
    );
    const dialog = document.querySelector('[data-testid="my-confirm"]');
    // Message stays; the body slot renders alongside it.
    expect(dialog?.textContent).toContain("Give it a name.");
    const field = document.querySelector('[data-testid="body-field"]');
    expect(field).toBeTruthy();
    // The body slot renders above the action row.
    const confirmBtn = document.querySelector('[data-testid="confirm-dialog-confirm"]');
    expect(
      field!.compareDocumentPosition(confirmBtn!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders a children-only body with no message", () => {
    render(
      <ConfirmDialog
        open
        title="Save host"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        data-testid="my-confirm"
      >
        <input data-testid="body-field" />
      </ConfirmDialog>
    );
    expect(document.querySelector('[data-testid="body-field"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="confirm-dialog-confirm"]')).toBeTruthy();
  });

  it("disables the confirm button when confirmDisabled is set", () => {
    render(
      <ConfirmDialog open title="Save host" confirmDisabled onConfirm={vi.fn()} onCancel={vi.fn()}>
        <input data-testid="body-field" />
      </ConfirmDialog>
    );
    const confirmBtn = document.querySelector(
      '[data-testid="confirm-dialog-confirm"]'
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("renders the don't-ask-again checkbox and reports changes", () => {
    const onChange = vi.fn();
    render(
      <ConfirmDialog
        open
        title="T"
        message="M"
        dontAskAgain={{ checked: false, onChange }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const box = dontAskAgain();
    expect(box).toBeTruthy();
    act(() => box.click());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // The opt-out takes effect on Confirm, so it must read as a checkbox and not
  // as a switch — a switch tells the user it applied the moment it was flipped.
  it("exposes the don't-ask-again opt-out as a checkbox, not a switch", () => {
    render(
      <ConfirmDialog
        open
        title="T"
        message="M"
        dontAskAgain={{ checked: false, onChange: vi.fn() }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const box = dontAskAgain();
    expect(box.getAttribute("role")).toBe("checkbox");
    expect(box.getAttribute("role")).not.toBe("switch");
    expect(box.classList.contains("ui-checkbox")).toBe(true);
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects the checked state of the don't-ask-again opt-out", () => {
    render(
      <ConfirmDialog
        open
        title="T"
        message="M"
        dontAskAgain={{ checked: true, onChange: vi.fn() }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(dontAskAgain().getAttribute("aria-checked")).toBe("true");
  });

  it("labels the don't-ask-again opt-out with the custom label", () => {
    render(
      <ConfirmDialog
        open
        title="T"
        message="M"
        dontAskAgain={{ checked: false, onChange: vi.fn(), label: "Don't warn again" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(dontAskAgain().getAttribute("aria-label")).toBe("Don't warn again");
    expect(document.querySelector(".ui-confirm__ask-again")?.textContent).toContain(
      "Don't warn again"
    );
  });

  // Clicking the wrapping <label> must reach the control exactly once: a label
  // around a button can forward the click and re-toggle it straight back.
  it("toggles once when the don't-ask-again label text is clicked", () => {
    const onChange = vi.fn();
    render(
      <ConfirmDialog
        open
        title="T"
        message="M"
        dontAskAgain={{ checked: false, onChange }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    act(() => (document.querySelector(".ui-confirm__ask-again span") as HTMLElement).click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  describe("title accent icon (per variant)", () => {
    /** The title accent-icon wrapper, or null when the variant renders none. */
    function titleIcon(base = "confirm-dialog"): HTMLElement | null {
      return document.querySelector(`[data-testid="${base}-title-icon"]`);
    }

    it("renders no accent icon for the default variant", () => {
      render(<ConfirmDialog open title="T" message="M" onConfirm={vi.fn()} onCancel={vi.fn()} />);
      expect(titleIcon()).toBeNull();
    });

    it("renders a danger-tinted alert triangle for variant=danger", () => {
      render(
        <ConfirmDialog
          open
          variant="danger"
          title="Delete"
          message="M"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      const icon = titleIcon();
      expect(icon).toBeTruthy();
      expect(icon!.classList.contains("ui-confirm__title-icon--danger")).toBe(true);
      expect(icon!.querySelector("svg")?.classList.contains("lucide-triangle-alert")).toBe(true);
    });

    it("renders a warning-tinted alert triangle for variant=warn", () => {
      render(
        <ConfirmDialog
          open
          variant="warn"
          title="Large scan"
          message="M"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      const icon = titleIcon();
      expect(icon).toBeTruthy();
      expect(icon!.classList.contains("ui-confirm__title-icon--warn")).toBe(true);
      expect(icon!.querySelector("svg")?.classList.contains("lucide-triangle-alert")).toBe(true);
    });

    // The WoL "save device" case: a default-variant dialog with a caller icon.
    it("renders a caller-supplied icon untinted on the default variant", () => {
      render(
        <ConfirmDialog
          open
          title="Save Wake-on-LAN Device"
          icon={<svg data-testid="my-icon" />}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        >
          <input data-testid="body-field" />
        </ConfirmDialog>
      );
      const icon = titleIcon();
      expect(icon).toBeTruthy();
      expect(icon!.classList.contains("ui-confirm__title-icon--default")).toBe(true);
      expect(icon!.querySelector('[data-testid="my-icon"]')).toBeTruthy();
    });

    // A caller icon overrides the variant's default glyph but keeps the tint.
    it("lets a caller icon override the variant default icon while keeping the tint", () => {
      render(
        <ConfirmDialog
          open
          variant="danger"
          title="Delete"
          message="M"
          icon={<svg data-testid="my-icon" />}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      const icon = titleIcon();
      expect(icon!.classList.contains("ui-confirm__title-icon--danger")).toBe(true);
      expect(icon!.querySelector('[data-testid="my-icon"]')).toBeTruthy();
      expect(icon!.querySelector(".lucide-triangle-alert")).toBeNull();
    });

    it("derives the title-icon test id from testIdBase", () => {
      render(
        <ConfirmDialog
          open
          variant="danger"
          title="Delete"
          message="M"
          testIdBase="confirm-delete"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      expect(titleIcon("confirm-delete")).toBeTruthy();
      expect(titleIcon("confirm-dialog")).toBeNull();
    });
  });

  // WAI-ARIA: Space activates a checkbox, Enter does not. Enter inside the
  // dialog stays the confirm shortcut rather than ticking the opt-out.
  it("confirms rather than ticking the opt-out when Enter is pressed on it", () => {
    const onConfirm = vi.fn();
    const onChange = vi.fn();
    render(
      <ConfirmDialog
        open
        title="T"
        message="M"
        dontAskAgain={{ checked: false, onChange }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );
    const box = dontAskAgain();
    act(() => box.focus());
    act(() => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
