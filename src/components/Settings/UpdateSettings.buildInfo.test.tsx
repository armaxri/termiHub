import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { TooltipProvider } from "@/components/ui";
import { UpdateSettings } from "./UpdateSettings";

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useAppInfo", () => ({
  useAppInfo: () => ({
    version: "0.1.0",
    gitHash: "1cdb14920",
    isDev: true,
    buildBranch: "develop",
  }),
}));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, toast: { ...actual.toast, success: toastSuccess, error: toastError } };
});

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const mockedWriteText = vi.mocked(writeText);

let container: HTMLDivElement;
let root: Root;

setupSettingsRegion();

describe("UpdateSettings build info (#5561)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockedWriteText.mockReset();
    mockedWriteText.mockResolvedValue(undefined);
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <UpdateSettings />
        </TooltipProvider>
      );
    });
  }

  const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it("shows version and build in one place, with a copy button", async () => {
    await render();
    expect(byId("update-current-version")?.textContent).toBe("v0.1.0");
    expect(byId("update-build-hash")?.textContent).toBe("1cdb14920");
    expect(byId("update-copy-build-info")?.getAttribute("aria-label")).toBe(
      "Copy version and build"
    );
  });

  it("copies version and commit and confirms with a toast", async () => {
    await render();
    await act(async () => {
      byId("update-copy-build-info")!.click();
    });
    expect(mockedWriteText).toHaveBeenCalledWith("termiHub v0.1.0 [DEV] (1cdb14920)");
    expect(toastSuccess).toHaveBeenCalledWith("Build info copied to clipboard");
  });

  it("reports a clipboard failure instead of failing silently", async () => {
    mockedWriteText.mockRejectedValue(new Error("denied"));
    await render();
    await act(async () => {
      byId("update-copy-build-info")!.click();
    });
    expect(toastError).toHaveBeenCalledWith("Failed to copy build info: denied");
  });
});
