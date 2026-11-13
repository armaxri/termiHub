/**
 * #5555 — "X11 forwarding by default" is opt-in, like OpenSSH's `ForwardX11 no`.
 *
 * A fresh profile (no stored value) shows the toggle off and explains what
 * turning it on exposes; a stored `true` from an existing profile stays on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AppSettings } from "@/types/connection";
import { GeneralSettings } from "./GeneralSettings";
import { TooltipProvider } from "@/components/ui";

vi.mock("@/utils/shell-detection", () => ({
  detectAvailableShells: vi.fn().mockResolvedValue([]),
  getWslDistroName: vi.fn(() => null),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
  frontendError: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  getLogFilePath: vi.fn().mockResolvedValue("/tmp/termihub.log"),
  setFileLogLevel: vi.fn().mockResolvedValue(undefined),
}));

const FRESH: AppSettings = {
  version: "2",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

let container: HTMLDivElement;
let root: Root;

async function renderWith(settings: AppSettings) {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <GeneralSettings settings={settings} onChange={vi.fn()} />
      </TooltipProvider>
    );
  });
  return container.querySelector<HTMLElement>("[data-testid='settings-default-x11-forwarding']");
}

describe("GeneralSettings — X11 forwarding default (#5555)", () => {
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

  it("is off in a fresh profile", async () => {
    const toggle = await renderWith(FRESH);
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps an existing profile's explicit on", async () => {
    const toggle = await renderWith({ ...FRESH, defaultX11Forwarding: true });
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
  });

  it("explains what turning it on exposes", async () => {
    await renderWith(FRESH);
    const field = container
      .querySelector("[data-testid='settings-default-x11-forwarding']")!
      .closest(".settings-form__field")!;
    expect(field.textContent).toContain("Off by default");
    expect(field.textContent).toContain("local X server");
  });
});
