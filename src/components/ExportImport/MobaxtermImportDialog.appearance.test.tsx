import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type {
  AppSettings,
  MobaxtermGlobalAppearance,
  MobaxtermImportPreview,
} from "@/types/connection";
import { MobaxtermImportDialog } from "./MobaxtermImportDialog";
import { discoverMobaxtermConfigs, previewMobaxtermImport } from "@/services/api";

vi.mock("@/services/api", () => ({
  discoverMobaxtermConfigs: vi.fn(),
  previewMobaxtermImport: vi.fn(),
  importMobaxtermHostKeys: vi.fn(),
}));

vi.mock("@/services/nativeDialog", () => ({
  open: vi.fn(),
}));

const mockedDiscover = vi.mocked(discoverMobaxtermConfigs);
const mockedPreview = vi.mocked(previewMobaxtermImport);

let container: HTMLDivElement;
let root: Root;

const SETTINGS: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

const GLOBAL: MobaxtermGlobalAppearance = {
  colors: {
    foreground: "#ececec",
    background: "#1e1e1e",
    ansi: Array<string | null>(16).fill("#808080"),
  },
  fontSize: 16,
  cursorStyle: "underline",
};

function preview(globalAppearance?: MobaxtermGlobalAppearance): MobaxtermImportPreview {
  return {
    sourcePath: "C:\\x.ini",
    encoding: "utf-8",
    sessions: [],
    hostKeys: [],
    globalAppearance,
    notes: [],
  };
}

function q(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`);
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function click(testid: string) {
  await act(async () => {
    (q(testid) as HTMLElement).click();
  });
  await flush();
}

async function renderWith(global?: MobaxtermGlobalAppearance) {
  mockedDiscover.mockResolvedValue([{ path: "C:\\x.ini", source: "installed" }]);
  mockedPreview.mockResolvedValue(preview(global));
  const onApplySettings = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  act(() => {
    root.render(
      <MobaxtermImportDialog
        open
        onOpenChange={onOpenChange}
        folders={[]}
        existingConnections={[]}
        onImport={vi.fn()}
        settings={SETTINGS}
        onApplySettings={onApplySettings}
      />
    );
  });
  await flush();
  return { onApplySettings, onOpenChange };
}

describe("MobaxtermImportDialog global appearance (#4880)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("offers both opt-ins off by default and applies nothing", async () => {
    await renderWith(GLOBAL);
    expect(q("mobaxterm-import-empty")).toBeNull();
    expect(q("mobaxterm-import-theme-optin")?.getAttribute("aria-checked")).toBe("false");
    expect(q("mobaxterm-import-appearance-optin")?.getAttribute("aria-checked")).toBe("false");
    expect(q("mobaxterm-import-theme-swatches")?.children).toHaveLength(18);
    expect((q("mobaxterm-import-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the font and cursor changes as before → after", async () => {
    await renderWith(GLOBAL);
    const text = q("mobaxterm-import-appearance-changes")?.textContent ?? "";
    expect(text).toContain("Font size14 px16 px");
    expect(text).toContain("Cursor styleBlockUnderline");
  });

  it("creates and selects a new theme only after opting in", async () => {
    const { onApplySettings, onOpenChange } = await renderWith(GLOBAL);
    await click("mobaxterm-import-theme-optin");
    expect(q("mobaxterm-import-submit")?.textContent).toBe("Apply appearance");
    await click("mobaxterm-import-submit");

    expect(onApplySettings).toHaveBeenCalledTimes(1);
    const next = onApplySettings.mock.calls[0][0] as AppSettings;
    expect(next.customThemes).toHaveLength(1);
    expect(next.customThemes![0].name).toBe("MobaXterm");
    expect(next.customThemes![0].colors.terminalBg).toBe("#1e1e1e");
    expect(next.theme).toBe(`custom:${next.customThemes![0].id}`);
    expect(next.fontSize).toBeUndefined();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("applies the font and cursor without creating a theme", async () => {
    const { onApplySettings } = await renderWith(GLOBAL);
    await click("mobaxterm-import-appearance-optin");
    await click("mobaxterm-import-submit");
    const next = onApplySettings.mock.calls[0][0] as AppSettings;
    expect(next.customThemes).toBeUndefined();
    expect(next.fontSize).toBe(16);
    expect(next.cursorStyle).toBe("underline");
  });

  it("hides the section when the file has no global appearance", async () => {
    await renderWith(undefined);
    expect(q("mobaxterm-import-appearance")).toBeNull();
    expect(q("mobaxterm-import-empty")).not.toBeNull();
  });
});
