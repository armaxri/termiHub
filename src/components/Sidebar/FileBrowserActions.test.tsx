/**
 * The file browser's header actions (#5520): a few icons plus one labelled
 * "…" overflow menu; narrow widths collapse more icons into the menu.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const width = vi.hoisted(() => ({ value: null as number | null }));
vi.mock("@/hooks/useElementWidth", () => ({
  useElementWidth: () => [() => {}, width.value],
}));

import { TooltipProvider } from "@/components/ui";
import { openFileBrowserMoreMenu } from "@/test/fileBrowserMenu";
import { FileBrowserActions, fitInlineActions, type FileBrowserAction } from "./FileBrowserActions";
import { buildFileBrowserActions, type FileBrowserActionsInput } from "./fileBrowserHeaderActions";

let container: HTMLDivElement;
let root: Root;

function input(overrides: Partial<FileBrowserActionsInput> = {}): FileBrowserActionsInput {
  const noop = () => {};
  return {
    mode: "local",
    currentPath: "/home/user",
    isLoading: false,
    reducedMotion: false,
    hasCwd: true,
    canCd: true,
    showHiddenFiles: false,
    vscodeAvailable: true,
    fileManagerLabel: "Reveal in Finder",
    pasteTooltip: null,
    bookmarksMenu: null,
    onNavigateUp: noop,
    onNavigateToCwd: noop,
    onCdHere: noop,
    onRefresh: noop,
    onOpenTransferView: noop,
    onToggleHidden: noop,
    onOpenInFileManager: noop,
    onOpenInVscode: noop,
    onUpload: noop,
    onPaste: noop,
    onNewFile: noop,
    onNewFolder: noop,
    ...overrides,
  };
}

function render(actions: FileBrowserAction[]) {
  act(() => {
    root.render(
      <TooltipProvider>
        <FileBrowserActions actions={actions} />
      </TooltipProvider>
    );
  });
}

/** Test ids of the inline buttons, in order. */
function inlineIds(): string[] {
  const row = container.querySelector('[data-testid="file-browser-actions"]')!;
  return Array.from(row.querySelectorAll<HTMLElement>(":scope > button"))
    .map((b) => b.dataset.testid ?? "")
    .filter((id) => id !== "file-browser-more-actions");
}

/** Text of every entry of the open overflow menu. */
function menuLabels(): string[] {
  const menu = document.querySelector('[data-testid="file-browser-more-menu"]')!;
  return Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((el) =>
    (el.textContent ?? "").trim()
  );
}

beforeEach(() => {
  width.value = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("fitInlineActions", () => {
  const base = { widths: [28, 28, 28, 28], pinned: 2, triggerWidth: 28, gap: 2 };

  it("fits every candidate when the width is unknown", () => {
    expect(fitInlineActions({ ...base, available: null })).toBe(4);
  });

  it("fits as many as the row holds beside the trigger", () => {
    // trigger 28 + 3 * (2 + 28) = 118
    expect(fitInlineActions({ ...base, available: 118 })).toBe(3);
    expect(fitInlineActions({ ...base, available: 117 })).toBe(2);
    expect(fitInlineActions({ ...base, available: 500 })).toBe(4);
  });

  it("never drops below the pinned actions", () => {
    expect(fitInlineActions({ ...base, available: 10 })).toBe(2);
  });
});

describe("buildFileBrowserActions", () => {
  it("keeps only the most-used local actions as icons", () => {
    render(buildFileBrowserActions(input()));
    expect(inlineIds()).toEqual([
      "file-browser-up",
      "file-browser-refresh",
      "file-browser-new-file",
      "file-browser-new-folder",
    ]);
  });

  it("adds Upload for a remote session and Paste only while the clipboard holds entries", () => {
    render(buildFileBrowserActions(input({ mode: "session", pasteTooltip: 'Paste "a" (copy)' })));
    expect(inlineIds()).toEqual([
      "file-browser-up",
      "file-browser-refresh",
      "file-browser-new-file",
      "file-browser-new-folder",
      "file-browser-upload",
      "file-browser-paste",
    ]);
  });

  it("disables Up at a filesystem or drive root", () => {
    for (const currentPath of ["/", "C:/", "D:"]) {
      const up = buildFileBrowserActions(input({ currentPath })).find((a) => a.id === "up");
      expect(up?.disabled, currentPath).toBe(true);
    }
  });

  it("lists the rest as labelled, grouped menu entries", async () => {
    render(buildFileBrowserActions(input()));
    await openFileBrowserMoreMenu();
    expect(menuLabels()).toEqual([
      "Go to terminal working directory",
      "Send cd for this folder to the terminal",
      "Paste",
      "Show hidden files",
      "Open dual-pane transfer view",
      "Reveal in Finder",
      "Open folder in VS Code",
    ]);
    const menu = document.querySelector('[data-testid="file-browser-more-menu"]')!;
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.querySelectorAll('[role="separator"]').length).toBe(4);
    // The hidden-files toggle is a checkbox entry.
    const toggle = document.querySelector('[data-testid="file-browser-toggle-hidden"]')!;
    expect(toggle.getAttribute("role")).toBe("menuitemcheckbox");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("runs the action's handler from its menu entry", async () => {
    const onOpenTransferView = vi.fn();
    render(buildFileBrowserActions(input({ onOpenTransferView })));
    await openFileBrowserMoreMenu();
    await act(async () => {
      (
        document.querySelector('[data-testid="file-browser-open-transfer-view"]') as HTMLElement
      ).click();
    });
    expect(onOpenTransferView).toHaveBeenCalledTimes(1);
  });

  it("collapses the lowest-priority icons into the menu at a narrow width", async () => {
    // Fallback icon 28px + 2px gaps: trigger + Up + Refresh + one more = 118.
    width.value = 118;
    render(buildFileBrowserActions(input({ mode: "session" })));
    expect(inlineIds()).toEqual(["file-browser-up", "file-browser-refresh", "file-browser-upload"]);
    await openFileBrowserMoreMenu();
    // Collapsed icons lead the menu, in display order.
    expect(menuLabels().slice(0, 2)).toEqual(["New file", "New folder"]);
  });

  it("keeps Up and Refresh inline however narrow the row is", () => {
    width.value = 20;
    render(buildFileBrowserActions(input()));
    expect(inlineIds()).toEqual(["file-browser-up", "file-browser-refresh"]);
  });
});
