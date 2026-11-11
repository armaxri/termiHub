/**
 * The inline pointer to the experimental-features toggle (#5363): it names the
 * toggle by the same label Settings ▸ General shows and opens that category.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ExperimentalSettingLink } from "./ExperimentalSettingLink";

const openSettingsTab = vi.fn();

vi.mock("@/store/appStore", () => {
  const state = { openSettingsTab: (...args: unknown[]) => openSettingsTab(...args) };
  const useAppStore = (selector: (s: typeof state) => unknown) => selector(state);
  return { useAppStore };
});

let container: HTMLDivElement;
let root: Root;

describe("ExperimentalSettingLink", () => {
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

  it("names the toggle by its Settings label and opens Settings ▸ General", () => {
    act(() => root.render(<ExperimentalSettingLink data-testid="link" />));
    const link = container.querySelector<HTMLButtonElement>('[data-testid="link"]')!;
    expect(link.textContent).toBe("Settings ▸ General ▸ Allow Experimental Features");
    expect(link.className).toBe("ui-empty__link");
    act(() => link.click());
    expect(openSettingsTab).toHaveBeenCalledWith({ category: "general" });
  });

  it("accepts a caller-specific class", () => {
    act(() => root.render(<ExperimentalSettingLink className="custom" data-testid="link" />));
    expect(container.querySelector('[data-testid="link"]')!.className).toBe("custom");
  });
});
