import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { discoverMobaxtermConfigs } from "@/services/api";
import { ImportMigrationSettings } from "./ImportMigrationSettings";

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  discoverMobaxtermConfigs: vi.fn(),
}));

const mockedDiscover = vi.mocked(discoverMobaxtermConfigs);

let container: HTMLDivElement;
let root: Root;

async function renderSettings() {
  await act(async () => {
    root.render(<ImportMigrationSettings />);
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function q(testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`);
}

describe("ImportMigrationSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("names the discovered MobaXterm configuration", async () => {
    mockedDiscover.mockResolvedValue([
      { path: "C:\\Users\\a\\AppData\\Roaming\\MobaXterm\\MobaXterm.ini", source: "installed" },
    ]);
    await renderSettings();
    expect(q("import-migration-mobaxterm-hint")?.textContent).toContain(
      "Found MobaXterm configuration at C:\\Users\\a\\AppData\\Roaming\\MobaXterm\\MobaXterm.ini"
    );
  });

  it("explains the manual pick when nothing is found or discovery fails", async () => {
    mockedDiscover.mockResolvedValue([]);
    await renderSettings();
    expect(q("import-migration-mobaxterm-hint")?.textContent).toContain(
      "No MobaXterm configuration was found"
    );

    act(() => root.unmount());
    root = createRoot(container);
    mockedDiscover.mockRejectedValue("boom");
    await renderSettings();
    expect(q("import-migration-mobaxterm-hint")?.textContent).toContain(
      "No MobaXterm configuration was found"
    );
  });

  it("opens the MobaXterm import dialog through the store", async () => {
    mockedDiscover.mockResolvedValue([]);
    await renderSettings();
    expect(useAppStore.getState().mobaxtermImportOpen).toBe(false);
    await act(async () => {
      q("import-migration-mobaxterm-btn")!.click();
    });
    expect(useAppStore.getState().mobaxtermImportOpen).toBe(true);
  });
});
