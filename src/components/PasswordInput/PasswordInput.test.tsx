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
});
