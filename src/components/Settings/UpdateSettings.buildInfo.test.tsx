import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { TooltipProvider } from "@/components/ui";
import { UpdateSettings } from "./UpdateSettings";

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

const appInfo = vi.hoisted(() => ({
  current: {
    version: "0.1.0",
    gitHash: "1cdb14920",
    isDev: true,
    buildBranch: "develop",
    buildCommitTime: "2026-11-13T09:42:07Z" as string | null,
  },
}));

vi.mock("@/hooks/useAppInfo", () => ({
  useAppInfo: () => appInfo.current,
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
    appInfo.current = { ...appInfo.current, buildCommitTime: "2026-11-13T09:42:07Z" };
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
    expect(mockedWriteText).toHaveBeenCalledWith(
      "termiHub v0.1.0 [DEV] (1cdb14920, commit time 2026-11-13T09:42:07Z)"
    );
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

  describe("build date (#5652)", () => {
    it("shows the commit time as a localized date with time zone", async () => {
      await render();
      const date = byId("update-build-date");
      expect(date).not.toBeNull();
      expect(date!.getAttribute("title")).toBe("Commit time of this build");
      const text = date!.textContent ?? "";
      expect(text).toContain("2026");
      expect(text).toMatch(/Nov/);
      // A time zone name is part of the format (e.g. "UTC", "GMT+1", "CET").
      expect(text).toMatch(/(UTC|GMT|[A-Z]{2,5})/);
      expect(text).not.toContain("Invalid");
    });

    it.each([
      ["missing", null],
      ["empty", ""],
      ["unparseable", "not-a-date"],
    ])("hides the row and keeps the copy text plain when the time is %s", async (_, value) => {
      appInfo.current = { ...appInfo.current, buildCommitTime: value };
      await render();
      expect(byId("update-build-date")).toBeNull();
      expect(container.textContent).not.toContain("Invalid Date");
      await act(async () => {
        byId("update-copy-build-info")!.click();
      });
      expect(mockedWriteText).toHaveBeenCalledWith("termiHub v0.1.0 [DEV] (1cdb14920)");
    });
  });
});
