import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SearchInput } from "./SearchInput";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("SearchInput", () => {
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

  it("renders a search input composed from the Input primitive", () => {
    render(<SearchInput value="" onValueChange={() => {}} data-testid="search" />);
    const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("type")).toBe("search");
    expect(input.classList.contains("ui-input")).toBe(true);
  });

  it("forwards placeholder, aria-label, and data-testid to the input", () => {
    render(
      <SearchInput
        value=""
        onValueChange={() => {}}
        placeholder="Search macros"
        aria-label="Search macros"
        data-testid="macro-search"
      />
    );
    const input = document.querySelector('[data-testid="macro-search"]') as HTMLInputElement;
    expect(input.placeholder).toBe("Search macros");
    expect(input.getAttribute("aria-label")).toBe("Search macros");
  });

  it("reflects the controlled value", () => {
    render(<SearchInput value="prod" onValueChange={() => {}} data-testid="search" />);
    const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
    expect(input.value).toBe("prod");
  });

  it("calls onValueChange with the new value on input", () => {
    const onValueChange = vi.fn();
    render(<SearchInput value="" onValueChange={onValueChange} data-testid="search" />);
    const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
    // Set the value via the native setter so React's value tracker notices the
    // change and dispatches onChange from the bubbled input event.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "abc");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onValueChange).toHaveBeenCalledWith("abc");
  });

  it("renders a leading search icon", () => {
    render(<SearchInput value="" onValueChange={() => {}} />);
    const icon = container.querySelector(".ui-search-input__icon");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("hides the clear button when the value is empty", () => {
    render(<SearchInput value="" onValueChange={() => {}} />);
    expect(container.querySelector(".ui-search-input__clear")).toBeNull();
    expect(container.querySelector(".ui-search-input--clearable")).toBeNull();
  });

  it("shows the clear button when the value is non-empty", () => {
    render(<SearchInput value="prod" onValueChange={() => {}} />);
    const clear = container.querySelector(".ui-search-input__clear") as HTMLButtonElement;
    expect(clear).toBeTruthy();
    expect(clear.getAttribute("aria-label")).toBe("Clear search");
    expect(container.querySelector(".ui-search-input--clearable")).toBeTruthy();
  });

  it("uses a custom clear label when provided", () => {
    render(<SearchInput value="x" onValueChange={() => {}} clearLabel="Clear filter" />);
    const clear = container.querySelector(".ui-search-input__clear") as HTMLButtonElement;
    expect(clear.getAttribute("aria-label")).toBe("Clear filter");
  });

  it("clears the query when the clear button is clicked", () => {
    const onValueChange = vi.fn();
    render(<SearchInput value="prod" onValueChange={onValueChange} />);
    const clear = container.querySelector(".ui-search-input__clear") as HTMLButtonElement;
    act(() => clear.click());
    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it("forwards a ref to the underlying input element", () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<SearchInput value="" onValueChange={() => {}} data-testid="search" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current).toBe(document.querySelector('[data-testid="search"]'));
  });

  it("forwards the compact size to the input", () => {
    render(<SearchInput value="" onValueChange={() => {}} size="sm" data-testid="search" />);
    const input = document.querySelector('[data-testid="search"]') as HTMLInputElement;
    expect(input.classList.contains("ui-input--sm")).toBe(true);
  });
});
