/**
 * #5860 (G-007, G-010): a setting looked for in one place points to where it
 * lives. X11 forwarding points to the X server page (folded under Advanced), and
 * Terminal points to Appearance for the font and colors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { AppSettings } from "@/types/connection";
import { ConnectionDefaultsSettings } from "./ConnectionDefaultsSettings";
import { TerminalSettings } from "./TerminalSettings";

vi.mock("@/themes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/themes")>()),
  applyTheme: vi.fn(),
}));

const SETTINGS: AppSettings = {
  version: "2",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

let container: HTMLDivElement;
let root: Root;
const query = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function render(node: React.ReactNode) {
  await act(async () => root.render(<TooltipProvider delayDuration={0}>{node}</TooltipProvider>));
}

describe("Settings cross-links (#5860)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("points from X11 forwarding to the X server page (G-007)", async () => {
    await render(<ConnectionDefaultsSettings settings={SETTINGS} onChange={vi.fn()} />);
    await act(async () => query("settings-default-x11-xserver-link")!.click());
    expect(useAppStore.getState().pendingSettingsCategory).toBe("x-server");
  });

  it("points from Terminal to Appearance for the font, outside a search (G-010)", async () => {
    await render(<TerminalSettings settings={SETTINGS} onChange={vi.fn()} />);
    expect(query("settings-terminal-font-link-line")?.textContent).toContain("font and colors");
    await act(async () => query("settings-terminal-font-link")!.click());
    expect(useAppStore.getState().pendingSettingsCategory).toBe("appearance");

    await render(
      <TerminalSettings
        settings={SETTINGS}
        onChange={vi.fn()}
        visibleFields={new Set(["scrollbackBuffer"])}
      />
    );
    expect(query("settings-terminal-font-link-line")).toBeNull();
  });
});
