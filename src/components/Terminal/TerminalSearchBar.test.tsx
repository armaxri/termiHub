/**
 * Tests for TerminalSearchBar after the Button-primitive migration.
 *
 * Covers that the migrated icon buttons still drive their handlers and that the
 * Match Case / Regex toggles reflect their pressed state through the Button
 * variant (secondary when active, ghost when inactive).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { flushAsync as flush } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import { TerminalSearchBar } from "./TerminalSearchBar";

const findNext = vi.fn();
const findPrevious = vi.fn();
const clearSearchDecorations = vi.fn();
const focusTerminal = vi.fn();

vi.mock("./TerminalRegistry", () => ({
  useTerminalRegistry: () => ({
    findNext,
    findPrevious,
    clearSearchDecorations,
    focusTerminal,
  }),
}));

const TAB_ID = "tab-1";

let container: HTMLDivElement;
let root: Root;

function buttonByLabel(label: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (!el) throw new Error(`No button with aria-label "${label}"`);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    terminalSearchVisible: { [TAB_ID]: true },
    setTerminalSearchVisible: vi.fn(),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(withTooltip(<TerminalSearchBar tabId={TAB_ID} />));
  });
  await flush();
}

describe("TerminalSearchBar (Button migration)", () => {
  it("renders the controls as shared Button primitives", async () => {
    await render();
    expect(buttonByLabel("Match Case").className).toContain("ui-btn");
    expect(buttonByLabel("Use Regular Expression").className).toContain("ui-btn");
    expect(buttonByLabel("Previous match").className).toContain("ui-btn");
    expect(buttonByLabel("Next match").className).toContain("ui-btn");
    expect(buttonByLabel("Close search").className).toContain("ui-btn");
  });

  it("reflects toggle state through the Button variant and aria-pressed", async () => {
    await render();
    const matchCase = buttonByLabel("Match Case");
    // Inactive → ghost variant.
    expect(matchCase.className).toContain("ui-btn--ghost");
    expect(matchCase.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      matchCase.click();
    });
    await flush();

    // Active → secondary variant.
    const matchCaseActive = buttonByLabel("Match Case");
    expect(matchCaseActive.className).toContain("ui-btn--secondary");
    expect(matchCaseActive.getAttribute("aria-pressed")).toBe("true");
  });

  it("closes the search bar via the migrated close button", async () => {
    const setVisible = vi.fn();
    useAppStore.setState({ setTerminalSearchVisible: setVisible });
    await render();

    await act(async () => {
      buttonByLabel("Close search").click();
    });
    await flush();

    expect(setVisible).toHaveBeenCalledWith(TAB_ID, false);
    expect(clearSearchDecorations).toHaveBeenCalledWith(TAB_ID);
    expect(focusTerminal).toHaveBeenCalledWith(TAB_ID);
  });

  it("finds next/previous through the migrated nav buttons", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>(".terminal-search-bar__input")!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    await act(async () => {
      setter.call(input, "foo");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    findNext.mockClear();

    await act(async () => {
      buttonByLabel("Next match").click();
    });
    expect(findNext).toHaveBeenCalledWith(
      TAB_ID,
      "foo",
      expect.objectContaining({ caseSensitive: false, regex: false })
    );

    await act(async () => {
      buttonByLabel("Previous match").click();
    });
    expect(findPrevious).toHaveBeenCalledWith(
      TAB_ID,
      "foo",
      expect.objectContaining({ caseSensitive: false, regex: false })
    );
  });
});
