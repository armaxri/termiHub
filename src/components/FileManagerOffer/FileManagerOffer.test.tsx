import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { ShellIntegrationStatus } from "@/types/connection";
import * as api from "@/services/api";
import { toast } from "@/components/ui";
import { defaultShellIntegrationSettings } from "@/components/Settings/shellIntegrationEntries";
import { useBottomBannerStore } from "@/components/BottomBanners";
import {
  FileManagerOffer,
  FILE_MANAGER_OFFER_TOAST_ID,
  __resetFileManagerOfferForTest,
} from "./FileManagerOffer";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    getShellIntegrationStatus: vi.fn(),
    saveShellIntegrationSettings: vi.fn(),
    installShellIntegration: vi.fn(),
  };
});

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      info: vi.fn(() => "file-manager-offer"),
      dismiss: vi.fn(),
      promise: vi.fn(<T,>(p: Promise<T>) => p),
    },
  };
});

const mockedApi = vi.mocked(api);
const mockedToast = vi.mocked(toast);

function status(overrides: Partial<ShellIntegrationStatus> = {}): ShellIntegrationStatus {
  return {
    registered: false,
    exePathMatches: true,
    stale: false,
    portable: false,
    detectedFileManagers: [],
    ...overrides,
  };
}

/** Both startup crash checks finished; `found` marks a crash notice. */
function crashChecks(found: { local?: boolean; agent?: boolean } = {}) {
  act(() => {
    const { markCrashChecked } = useBottomBannerStore.getState();
    markCrashChecked("local", found.local ?? false);
    markCrashChecked("agent", found.agent ?? false);
  });
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<FileManagerOffer />);
  });
}

/** Options of the (single) offer toast raised so far. */
function offerOptions() {
  expect(mockedToast.info).toHaveBeenCalledTimes(1);
  return mockedToast.info.mock.calls[0][1]!;
}

setupSettingsRegion();

describe("FileManagerOffer (#5753)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useBottomBannerStore.setState({
      wanting: {},
      crashNoticeThisSession: false,
      crashChecked: { local: false, agent: false },
    });
    __resetFileManagerOfferForTest();
    seedSettings({ shellIntegration: defaultShellIntegrationSettings() });
    mockedApi.getShellIntegrationStatus.mockResolvedValue(status());
    mockedApi.saveShellIntegrationSettings.mockResolvedValue(status());
    mockedApi.installShellIntegration.mockResolvedValue(status({ registered: true }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("offers Install and Not now in one persistent toast once nothing crashed", async () => {
    await render();
    crashChecks();
    const opts = offerOptions();
    expect(mockedToast.info.mock.calls[0][0]).toBe("Add “Open in termiHub” to your file manager?");
    expect(opts.id).toBe(FILE_MANAGER_OFFER_TOAST_ID);
    expect(opts.testId).toBe("file-manager-offer");
    expect(opts.duration).toBe(Infinity);
    expect(opts.action?.label).toBe("Install");
    expect(opts.cancel?.label).toBe("Not now");
    expect(opts.description).toContain("Settings › File manager integration");
  });

  it("persists that it was shown, so a later launch never offers it again", async () => {
    await render();
    crashChecks();
    await act(async () => {});
    expect(mockedApi.saveShellIntegrationSettings).toHaveBeenCalledTimes(1);
    expect(mockedApi.saveShellIntegrationSettings.mock.calls[0][0].firstLaunchBannerDismissed).toBe(
      true
    );
  });

  it("waits for both startup crash checks", async () => {
    await render();
    act(() => useBottomBannerStore.getState().markCrashChecked("local", false));
    expect(mockedToast.info).not.toHaveBeenCalled();
    act(() => useBottomBannerStore.getState().markCrashChecked("agent", false));
    expect(mockedToast.info).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the local crash notice", { local: true }],
    ["an agent crash notice", { agent: true }],
  ])("is never shown in a session with %s, and stays offered for later", async (_, found) => {
    await render();
    crashChecks(found);
    // The notice is closed again later in the session: still no offer.
    act(() => useBottomBannerStore.getState().setWanting("crash-report", false));
    await act(async () => {});
    expect(mockedToast.info).not.toHaveBeenCalled();
    expect(mockedApi.saveShellIntegrationSettings).not.toHaveBeenCalled();
  });

  it("takes the toast down when a crash notice turns up while it shows", async () => {
    await render();
    crashChecks();
    expect(mockedToast.info).toHaveBeenCalledTimes(1);
    act(() => useBottomBannerStore.getState().setWanting("agent-crash-report", true));
    expect(mockedToast.dismiss).toHaveBeenCalledWith(FILE_MANAGER_OFFER_TOAST_ID);
  });

  it("respects the old banner's Don't show again", async () => {
    seedSettings({
      shellIntegration: { ...defaultShellIntegrationSettings(), firstLaunchBannerDismissed: true },
    });
    await render();
    crashChecks();
    expect(mockedToast.info).not.toHaveBeenCalled();
    expect(mockedApi.getShellIntegrationStatus).not.toHaveBeenCalled();
  });

  it("is not offered once the integration is registered", async () => {
    mockedApi.getShellIntegrationStatus.mockResolvedValue(status({ registered: true }));
    await render();
    crashChecks();
    expect(mockedToast.info).not.toHaveBeenCalled();
  });

  it("waits for the persisted settings before deciding", async () => {
    seedSettings({ shellIntegration: undefined });
    await render();
    crashChecks();
    expect(mockedToast.info).not.toHaveBeenCalled();
  });

  it("is raised only once per session, even across a remount", async () => {
    await render();
    crashChecks();
    act(() => root.unmount());
    root = createRoot(container);
    // A stale document (the persist not yet folded back) must not re-raise it.
    seedSettings({ shellIntegration: defaultShellIntegrationSettings() });
    await render();
    expect(mockedToast.info).toHaveBeenCalledTimes(1);
  });

  it("Install registers the integration behind a progress toast", async () => {
    await render();
    crashChecks();
    await act(async () => {
      offerOptions().action?.onClick();
    });
    expect(mockedApi.installShellIntegration).toHaveBeenCalledTimes(1);
    expect(mockedToast.promise).toHaveBeenCalledTimes(1);
  });

  it("Not now installs nothing", async () => {
    await render();
    crashChecks();
    await act(async () => {
      offerOptions().cancel?.onClick();
    });
    expect(mockedApi.installShellIntegration).not.toHaveBeenCalled();
  });
});
