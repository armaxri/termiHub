import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AlertTriangle } from "lucide-react";
import { BottomBanner, BottomBannerAction } from "./BottomBanner";

let container: HTMLDivElement;
let root: Root;

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

async function renderBanner(tone: "warning" | "info", onClose = vi.fn()) {
  await act(async () => {
    root.render(
      <BottomBanner
        tone={tone}
        icon={<AlertTriangle size={16} />}
        title="Something happened."
        description="A detail line."
        data-testid="banner"
        actions={
          <>
            <BottomBannerAction onClick={vi.fn()} data-testid="banner-never">
              Don't show again
            </BottomBannerAction>
            <BottomBannerAction onClick={onClose} data-testid="banner-close">
              Close
            </BottomBannerAction>
            <BottomBannerAction main onClick={vi.fn()} data-testid="banner-main">
              View report
            </BottomBannerAction>
          </>
        }
      />
    );
  });
}

describe("BottomBanner (#5638)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders title, description and the tone modifier", async () => {
    await renderBanner("warning");
    const banner = byTestId("banner");
    expect(banner?.className).toContain("bottom-banner");
    expect(banner?.className).toContain("bottom-banner--warning");
    expect(banner?.textContent).toContain("Something happened.");
    expect(banner?.textContent).toContain("A detail line.");
  });

  it("puts every action in the action row as a small Button primitive", async () => {
    await renderBanner("info");
    const row = byTestId("banner")?.querySelector(".bottom-banner__actions");
    const buttons = Array.from(row?.querySelectorAll("button") ?? []);
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      "Don't show again",
      "Close",
      "View report",
    ]);
    for (const b of buttons) {
      expect(b.className).toContain("ui-btn");
      expect(b.className).toContain("ui-btn--sm");
      expect(b.className).toContain("bottom-banner__action");
    }
  });

  it("gives exactly one action the main (secondary, never filled) emphasis", async () => {
    await renderBanner("info");
    const banner = byTestId("banner");
    expect(banner?.querySelector(".ui-btn--primary")).toBeNull();
    expect(banner?.querySelectorAll(".ui-btn--secondary")).toHaveLength(1);
    expect(byTestId("banner-main")?.className).toContain("ui-btn--secondary");
    expect(byTestId("banner-close")?.className).toContain("ui-btn--ghost");
    expect(byTestId("banner-never")?.className).toContain("ui-btn--ghost");
  });

  it("forwards clicks", async () => {
    const onClose = vi.fn();
    await renderBanner("warning", onClose);
    await act(async () => byTestId("banner-close")?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("BottomBanners.css (#5638)", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "BottomBanners.css"),
    "utf8"
  );

  it("paints ghost banner actions in full-contrast text", () => {
    const block = /\.bottom-banner__action\.ui-btn--ghost\s*\{([^}]*)\}/.exec(css);
    expect(block?.[1]).toMatch(/color:\s*var\(--text-primary\)/);
  });

  it("gives the warning banner an amber left accent", () => {
    const block = /\.bottom-banner--warning\s*\{([^}]*)\}/.exec(css);
    expect(block?.[1]).toMatch(/var\(--banner-accent-width\)/);
    expect(block?.[1]).toMatch(/var\(--color-warning\)/);
  });
});
