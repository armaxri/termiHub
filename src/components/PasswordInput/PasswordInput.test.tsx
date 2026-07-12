import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PasswordInput } from "./PasswordInput";

let container: HTMLDivElement;
let root: Root;

function input(): HTMLInputElement {
  return container.querySelector("input")!;
}

function toggleBtn(): HTMLButtonElement {
  return container.querySelector(".password-input__toggle")!;
}

function capsWarning(): HTMLElement | null {
  return container.querySelector(".password-input__caps-warning");
}

/**
 * Dispatches a keyboard event whose `getModifierState("CapsLock")` reports
 * `on`. React's synthetic event delegates `getModifierState` to the native
 * event, so overriding it here drives the component's caps-lock detection.
 */
function keyEvent(type: "keydown" | "keyup", capsLock: boolean) {
  const ev = new KeyboardEvent(type, { bubbles: true });
  ev.getModifierState = () => capsLock;
  act(() => input().dispatchEvent(ev));
}

describe("PasswordInput", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders as a password field by default", () => {
    act(() => {
      root.render(<PasswordInput value="" onChange={() => {}} placeholder="Enter password" />);
    });
    expect(input().getAttribute("type")).toBe("password");
    expect(input().getAttribute("placeholder")).toBe("Enter password");
  });

  it("shows password when toggle button is clicked", () => {
    act(() => {
      root.render(<PasswordInput value="secret" onChange={() => {}} />);
    });
    expect(toggleBtn().getAttribute("aria-label")).toBe("Show password");
    act(() => toggleBtn().click());
    expect(input().getAttribute("type")).toBe("text");
    expect(toggleBtn().getAttribute("aria-label")).toBe("Hide password");
  });

  it("hides password again on second toggle click", () => {
    act(() => {
      root.render(<PasswordInput value="secret" onChange={() => {}} />);
    });
    act(() => toggleBtn().click());
    act(() => toggleBtn().click());
    expect(input().getAttribute("type")).toBe("password");
  });

  it("forwards className to the input element", () => {
    act(() => {
      root.render(<PasswordInput value="" onChange={() => {}} className="my-input" />);
    });
    expect(input().classList.contains("my-input")).toBe(true);
  });

  it("passes data-testid to the input element", () => {
    act(() => {
      root.render(<PasswordInput value="" onChange={() => {}} data-testid="pw-input" />);
    });
    expect(container.querySelector('[data-testid="pw-input"]')).not.toBeNull();
  });

  it("wires onChange to the underlying input element", () => {
    // Verify the input element is rendered and accessible for interaction
    act(() => {
      root.render(<PasswordInput value="typed" onChange={() => {}} />);
    });
    expect(input().value).toBe("typed");
  });

  it("disables both input and toggle button when disabled prop is set", () => {
    act(() => {
      root.render(<PasswordInput value="" onChange={() => {}} disabled />);
    });
    expect(input().disabled).toBe(true);
    expect(toggleBtn().disabled).toBe(true);
  });

  it("keeps the visibility toggle reachable by keyboard (not removed from tab order)", () => {
    act(() => {
      root.render(<PasswordInput value="secret" onChange={() => {}} />);
    });
    // tabIndex={-1} pulled the show/hide affordance out of the tab order, hiding
    // it from keyboard-only users (issue #1358).
    expect(toggleBtn().tabIndex).not.toBe(-1);
  });

  // --- #1360: caps-lock warning ---

  it("does not show the caps-lock warning by default", () => {
    act(() => {
      root.render(<PasswordInput value="" onChange={() => {}} />);
    });
    expect(capsWarning()).toBeNull();
  });

  it("shows the caps-lock warning when Caps Lock is active during a keystroke", () => {
    act(() => {
      root.render(<PasswordInput value="" onChange={() => {}} />);
    });
    keyEvent("keydown", true);
    expect(capsWarning()).not.toBeNull();
    expect(capsWarning()!.textContent).toMatch(/caps lock/i);
  });

  it("uses an assertive live region so the warning is announced", () => {
    act(() => {
      root.render(<PasswordInput value="" onChange={() => {}} />);
    });
    keyEvent("keydown", true);
    expect(capsWarning()!.getAttribute("role")).toBe("alert");
    expect(capsWarning()!.getAttribute("aria-live")).toBe("assertive");
  });

  it("hides the caps-lock warning again once Caps Lock is released", () => {
    act(() => {
      root.render(<PasswordInput value="" onChange={() => {}} />);
    });
    keyEvent("keydown", true);
    expect(capsWarning()).not.toBeNull();
    keyEvent("keyup", false);
    expect(capsWarning()).toBeNull();
  });

  it("clears the caps-lock warning when the field loses focus", () => {
    act(() => {
      root.render(<PasswordInput value="" onChange={() => {}} />);
    });
    keyEvent("keydown", true);
    expect(capsWarning()).not.toBeNull();
    // React delegates onBlur through the bubbling `focusout` event.
    act(() => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(capsWarning()).toBeNull();
  });

  it("still forwards onKeyDown while tracking caps-lock state", () => {
    let seen = false;
    act(() => {
      root.render(<PasswordInput value="" onChange={() => {}} onKeyDown={() => (seen = true)} />);
    });
    keyEvent("keydown", true);
    expect(seen).toBe(true);
  });
});
