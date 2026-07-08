import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Progress } from "./Progress";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("Progress", () => {
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

  it("renders a determinate bar with the correct fill width and aria values", () => {
    render(<Progress value={25} max={100} label="Downloading" />);
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.classList.contains("ui-progress")).toBe(true);
    expect(bar.classList.contains("ui-progress--indeterminate")).toBe(false);
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-label")).toBe("Downloading");

    const fill = bar.querySelector(".ui-progress__fill") as HTMLElement;
    expect(fill.style.width).toBe("25%");
  });

  it("clamps values above max to 100% width", () => {
    render(<Progress value={500} max={100} />);
    const fill = container.querySelector(".ui-progress__fill") as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("renders indeterminate mode without aria-valuenow and no inline width", () => {
    render(<Progress indeterminate label="Transferring" />);
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.classList.contains("ui-progress--indeterminate")).toBe(true);
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.hasAttribute("aria-valuemax")).toBe(false);

    const fill = bar.querySelector(".ui-progress__fill") as HTMLElement;
    expect(fill.style.width).toBe("");
  });

  it("treats max <= 0 as indeterminate", () => {
    render(<Progress value={0} max={0} />);
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.classList.contains("ui-progress--indeterminate")).toBe(true);
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
  });
});
