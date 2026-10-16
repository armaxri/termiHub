import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { discoverMobaxtermConfigs } from "@/services/api";
import { MobaxtermImportHost } from "./MobaxtermImportHost";

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  discoverMobaxtermConfigs: vi.fn(() => Promise.resolve([])),
  previewMobaxtermImport: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

describe("MobaxtermImportHost", () => {
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

  it("opens and closes with the store flag", async () => {
    act(() => root.render(<MobaxtermImportHost />));
    expect(document.querySelector('[data-testid="mobaxterm-import-dialog"]')).toBeNull();
    expect(discoverMobaxtermConfigs).not.toHaveBeenCalled();

    await act(async () => {
      useAppStore.getState().setMobaxtermImportOpen(true);
    });
    expect(document.querySelector('[data-testid="mobaxterm-import-dialog"]')).not.toBeNull();
    expect(discoverMobaxtermConfigs).toHaveBeenCalledTimes(1);

    await act(async () => {
      (document.querySelector('[data-testid="mobaxterm-import-cancel"]') as HTMLElement).click();
    });
    expect(useAppStore.getState().mobaxtermImportOpen).toBe(false);
  });
});
