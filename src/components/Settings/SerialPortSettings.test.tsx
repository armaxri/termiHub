import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { SerialPortSettings } from "./SerialPortSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <SerialPortSettings />
      </TooltipProvider>
    );
  });
}

/** Find the Add button by its label (migrated to the shared Button primitive). */
function addButton(): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll("button"));
  return (buttons.find((b) => b.textContent?.includes("Add")) as HTMLButtonElement) ?? null;
}

function typePrefix(value: string) {
  const input = container.querySelector(
    ".settings-panel__add-row input"
  ) as HTMLInputElement | null;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SerialPortSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the section", () => {
    render();
    expect(container.querySelector('[data-testid="settings-serial-port-prefixes"]')).not.toBeNull();
  });

  it("renders the Add control as a real button element", () => {
    render();
    const btn = addButton();
    expect(btn).not.toBeNull();
    expect(btn?.tagName).toBe("BUTTON");
    expect(btn?.className).toContain("ui-btn");
  });

  it("disables Add while the prefix input is empty", () => {
    render();
    expect(addButton()?.disabled).toBe(true);
  });

  it("enables Add and persists a new prefix on click", () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ updateSettings });
    render();
    typePrefix("ttyXYZ");
    const btn = addButton();
    expect(btn?.disabled).toBe(false);
    act(() => {
      btn?.click();
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    const arg = updateSettings.mock.calls[0][0] as {
      serialPortScanPrefixes?: { prefix: string }[];
    };
    expect(arg.serialPortScanPrefixes?.some((p) => p.prefix === "ttyXYZ")).toBe(true);
  });
});
