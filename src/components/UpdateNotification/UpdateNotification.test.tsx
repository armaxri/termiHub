/**
 * Tests for UpdateNotification after the Button-primitive migration.
 *
 * Covers that the migrated actions still run (open downloads, skip, toggle
 * notes) and that "Open Downloads Page" is no longer silent on failure: an
 * openUrl rejection now surfaces a toast.error via the async Button lifecycle
 * (per the reactive design rule), instead of only logging.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { flushAsync as flush } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui/Toast";
import { UpdateNotification } from "./UpdateNotification";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

// Button surfaces async rejections through the ./Toast module directly.
vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return {
    ...actual,
    toast: { ...actual.toast, error: vi.fn(), success: vi.fn() },
  };
});

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    getAppInfo: vi.fn(() => Promise.resolve({ version: "1.0.0" })),
  };
});

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const mockedOpenUrl = vi.mocked(openUrl);

let container: HTMLDivElement;
let root: Root;

function byTestId(id: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    updateInfo: {
      available: true,
      latestVersion: "2.0.0",
      releaseUrl: "https://example.com/release",
      releaseNotes: "Fixed things.",
      isSecurity: false,
    },
    updateNotificationDismissed: false,
    settings: {
      ...useAppStore.getState().settings,
      updates: { autoCheck: true, skippedVersion: undefined },
    },
    dismissUpdateNotification: vi.fn(),
    skipUpdate: vi.fn(() => Promise.resolve()),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<UpdateNotification />);
  });
  await flush();
}

describe("UpdateNotification (Button migration)", () => {
  it("renders the migrated action buttons via the Button primitive", async () => {
    await render();
    expect(byTestId("update-notification-open-downloads")).not.toBeNull();
    expect(byTestId("update-notification-whats-new")).not.toBeNull();
    expect(byTestId("update-notification-skip")).not.toBeNull();
    // All compose from the shared primitive.
    expect(byTestId("update-notification-open-downloads")!.className).toContain("ui-btn");
  });

  it("opens the downloads page and dismisses on success", async () => {
    const dismiss = vi.fn();
    useAppStore.setState({ dismissUpdateNotification: dismiss });
    await render();

    await act(async () => {
      byTestId("update-notification-open-downloads")!.click();
    });
    await flush();

    expect(mockedOpenUrl).toHaveBeenCalledWith("https://example.com/release");
    expect(dismiss).toHaveBeenCalled();
  });

  it("surfaces a toast error when opening the downloads page fails", async () => {
    mockedOpenUrl.mockRejectedValueOnce(new Error("no browser"));
    const dismiss = vi.fn();
    useAppStore.setState({ dismissUpdateNotification: dismiss });
    await render();

    await act(async () => {
      byTestId("update-notification-open-downloads")!.click();
    });
    await flush();

    expect(toast.error).toHaveBeenCalled();
    // Failure must not silently dismiss the notification.
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("skips this version via the migrated ghost button", async () => {
    const skip = vi.fn(() => Promise.resolve());
    useAppStore.setState({ skipUpdate: skip });
    await render();

    await act(async () => {
      byTestId("update-notification-skip")!.click();
    });
    await flush();

    expect(skip).toHaveBeenCalled();
  });

  it("toggles the release notes panel via the What's New button", async () => {
    await render();
    expect(byTestId("update-notification-notes")).toBeNull();

    await act(async () => {
      byTestId("update-notification-whats-new")!.click();
    });
    await flush();

    expect(byTestId("update-notification-notes")).not.toBeNull();
  });
});
