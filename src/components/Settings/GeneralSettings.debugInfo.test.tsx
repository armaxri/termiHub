/**
 * OBS-008 — the "Copy debug info" diagnostics action in Settings -> Diagnostics.
 *
 * Clicking it must assemble a consolidated bundle (app version, build, platform,
 * log file path, credential store mode) and copy it to the clipboard, with any
 * secret redacted before it leaves the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AppSettings } from "@/types/connection";
import { GeneralSettings } from "./GeneralSettings";
import { resetAppInfoCache } from "@/hooks/useAppInfo";
import { TooltipProvider, toast } from "@/components/ui";
import { writeText as pluginWriteText } from "@tauri-apps/plugin-clipboard-manager";

vi.mock("@/utils/shell-detection", () => ({
  detectAvailableShells: vi.fn().mockResolvedValue([]),
  getWslDistroName: vi.fn(() => null),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
  frontendError: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  getLogFilePath: vi.fn().mockResolvedValue("/home/u/logs/termihub.log"),
  setFileLogLevel: vi.fn().mockResolvedValue(undefined),
  getCredentialStoreStatus: vi.fn().mockResolvedValue({ mode: "os_keychain", status: "unlocked" }),
  getAppInfo: vi.fn().mockResolvedValue({
    version: "0.1.0-dev",
    gitHash: "abc1234",
    isDev: true,
    buildBranch: "develop",
  }),
}));

const BASE_SETTINGS: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
  fileLogLevel: "info",
};

let container: HTMLDivElement;
let root: Root;
let browserWriteText: ReturnType<typeof vi.fn>;
const writeText = vi.mocked(pluginWriteText);

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("GeneralSettings — copy debug info (OBS-008)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    resetAppInfoCache();
    // The copy goes through the Tauri clipboard plugin (#4327); navigator.clipboard
    // rejects on macOS/WKWebView when the window is not focused.
    writeText.mockReset().mockResolvedValue(undefined);
    browserWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: browserWriteText } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("copies a redacted, consolidated debug bundle to the clipboard", async () => {
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <GeneralSettings settings={BASE_SETTINGS} onChange={() => {}} />
        </TooltipProvider>
      );
    });
    await flush();

    const button = container.querySelector<HTMLButtonElement>(
      "[data-testid='settings-copy-debug-info']"
    );
    expect(button).not.toBeNull();

    await act(async () => {
      button!.click();
    });
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("termiHub debug info");
    expect(copied).toContain("0.1.0-dev");
    expect(copied).toContain("abc1234");
    expect(copied).toContain("develop");
    expect(copied).toContain("/home/u/logs/termihub.log");
    expect(copied).toContain("os_keychain (unlocked)");
    expect(browserWriteText).not.toHaveBeenCalled();
  });

  it("reports a failed clipboard write with an error toast", async () => {
    const errorSpy = vi.spyOn(toast, "error");
    writeText.mockRejectedValue(new Error("clipboard denied"));
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <GeneralSettings settings={BASE_SETTINGS} onChange={() => {}} />
        </TooltipProvider>
      );
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='settings-copy-debug-info']")!
        .click();
    });
    await flush();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("clipboard denied"));
  });
});
