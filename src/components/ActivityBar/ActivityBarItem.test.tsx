import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Settings } from "lucide-react";
import { ActivityBarItem } from "./ActivityBarItem";
import { TooltipProvider } from "@/components/ui";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(props: { label: string; isActive: boolean; onClick: () => void }) {
  act(() => {
    root.render(
      <TooltipProvider>
        <ActivityBarItem icon={Settings} {...props} />
      </TooltipProvider>
    );
  });
}

describe("ActivityBarItem", () => {
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

  it("derives an aria-label and a slugified test id from the label", () => {
    render({ label: "Open Connections", isActive: false, onClick: vi.fn() });
    const button = query("activity-bar-open-connections");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Open Connections");
    // An icon (svg) is rendered inside the button.
    expect(button?.querySelector("svg")).not.toBeNull();
  });

  it("marks the button active and shows the indicator only when isActive", () => {
    render({ label: "Files", isActive: true, onClick: vi.fn() });
    const button = query("activity-bar-files");
    expect(button?.className).toContain("activity-bar__item--active");
    expect(container.querySelector(".activity-bar__indicator")).not.toBeNull();
  });

  it("is not active and renders no indicator when isActive is false", () => {
    render({ label: "Files", isActive: false, onClick: vi.fn() });
    const button = query("activity-bar-files");
    expect(button?.className).not.toContain("activity-bar__item--active");
    expect(container.querySelector(".activity-bar__indicator")).toBeNull();
  });

  it("invokes onClick when the button is clicked", () => {
    const onClick = vi.fn();
    render({ label: "Settings", isActive: false, onClick });
    act(() => {
      query("activity-bar-settings")?.click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
