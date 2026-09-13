import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { SettingsSearch } from "./SettingsSearch";

let container: HTMLDivElement;
let root: Root;

function input(): HTMLInputElement {
  return container.querySelector(".settings-search__input") as HTMLInputElement;
}

function clearButton(): HTMLButtonElement | null {
  return container.querySelector(".settings-search__clear");
}

function render(query: string, onQueryChange = vi.fn()) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <SettingsSearch query={query} onQueryChange={onQueryChange} />
      </TooltipProvider>
    );
  });
  return onQueryChange;
}

describe("SettingsSearch", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the current query as the input value with a placeholder", () => {
    render("theme");
    expect(input().value).toBe("theme");
    expect(input().placeholder).toBe("Search settings...");
  });

  it("emits typed text through onQueryChange", () => {
    const onChange = render("");
    const el = input();
    // React tracks the value via a native setter; set through it so the
    // synthetic onChange fires on the dispatched input event.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(el, "font");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("font");
  });

  it("hides the clear button when the query is empty", () => {
    render("");
    expect(clearButton()).toBeNull();
  });

  it("shows the clear button once there is a query", () => {
    render("shell");
    expect(clearButton()).not.toBeNull();
    expect(clearButton()?.getAttribute("aria-label")).toBe("Clear search");
  });

  it("clicking clear resets the query to an empty string", () => {
    const onChange = render("shell");
    act(() => clearButton()?.click());
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("Escape clears the query", () => {
    const onChange = render("shell");
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("ignores other keys", () => {
    const onChange = render("shell");
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
