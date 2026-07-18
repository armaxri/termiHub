/**
 * Tests for the guided Git-for-Windows setup dialog (#1672): "Install in
 * terminal" opens a local tab pre-loaded with the winget command and closes;
 * "Open git-scm.com" deep-links the official installer; "Not now" dismisses.
 * Nothing installs until the user acts. Composed from shared ui primitives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "@/store/appStore";
import { listAvailableShells } from "@/services/api";
import { GIT_FOR_WINDOWS_DOWNLOAD_URL, GIT_FOR_WINDOWS_WINGET_COMMAND } from "@/utils/gitBashSetup";
import { GitBashSetupDialog } from "./GitBashSetupDialog";

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  listAvailableShells: vi.fn(),
}));

const mockedListShells = vi.mocked(listAvailableShells);
const mockedOpenUrl = vi.mocked(openUrl);

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(testId: string) {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`missing button ${testId}`);
  act(() => el.click());
}

describe("GitBashSetupDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens a winget install terminal, notifies the caller, and closes", async () => {
    mockedListShells.mockResolvedValue(["powershell", "cmd"]);
    const addTab = vi.spyOn(useAppStore.getState(), "addTab").mockReturnValue("tab-1");
    const onOpenChange = vi.fn();
    const onInstallGuided = vi.fn();

    act(() => {
      root.render(
        <GitBashSetupDialog open onOpenChange={onOpenChange} onInstallGuided={onInstallGuided} />
      );
    });

    click("git-bash-setup-install");
    await flush();

    expect(addTab).toHaveBeenCalledTimes(1);
    const [, , config] = addTab.mock.calls[0];
    expect(config).toMatchObject({
      config: { initialCommand: GIT_FOR_WINDOWS_WINGET_COMMAND },
    });
    expect(onInstallGuided).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    addTab.mockRestore();
  });

  it("deep-links the official installer on 'Open git-scm.com'", async () => {
    const onOpenChange = vi.fn();
    act(() => {
      root.render(<GitBashSetupDialog open onOpenChange={onOpenChange} />);
    });

    click("git-bash-setup-download");
    await flush();

    expect(mockedOpenUrl).toHaveBeenCalledWith(GIT_FOR_WINDOWS_DOWNLOAD_URL);
  });

  it("dismisses without installing anything on 'Not now'", async () => {
    const addTab = vi.spyOn(useAppStore.getState(), "addTab");
    const onOpenChange = vi.fn();
    act(() => {
      root.render(<GitBashSetupDialog open onOpenChange={onOpenChange} />);
    });

    click("git-bash-setup-not-now");
    await flush();

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(addTab).not.toHaveBeenCalled();
    expect(mockedOpenUrl).not.toHaveBeenCalled();
    addTab.mockRestore();
  });
});
