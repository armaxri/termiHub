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
import { openFileBrowserMenuButton, openFileBrowserMoreMenu } from "@/test/fileBrowserMenu";
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
    onCopyPath: noop,
    sort: { key: "name", dir: "asc" },
    sortInMenu: false,
    onSort: noop,
    ...overrides,
  };
}

function render(actions: FileBrowserAction[], folder?: string) {
  act(() => {
    root.render(
      <TooltipProvider>
        <FileBrowserActions actions={actions} folder={folder} />
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
    expect(inlineIds()).toEqual(["file-browser-up", "file-browser-refresh", "file-browser-new"]);
  });

  it("adds Upload for a remote session and Paste only while the clipboard holds entries", () => {
    render(buildFileBrowserActions(input({ mode: "session", pasteTooltip: 'Paste "a" (copy)' })));
    expect(inlineIds()).toEqual([
      "file-browser-up",
      "file-browser-refresh",
      "file-browser-new",
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
      "Go to terminal folder",
      "Copy path",
      "Open this folder in terminal",
      "Paste",
      "Show hidden files",
      "Open dual-pane transfer view",
      "Reveal in Finder",
      "Open folder in VS Code",
    ]);
    const menu = document.querySelector('[data-testid="file-browser-more-menu"]')!;
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.querySelectorAll('[role="separator"]').length).toBe(4);
    // The column headers sort while they all show: no second control (#5832).
    expect(document.querySelector('[data-testid="file-browser-sort-menu"]')).toBeNull();
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
    // The first unpinned icon also brings the divider (1px + 2px gap): 121.
    width.value = 121;
    render(buildFileBrowserActions(input({ mode: "session" })));
    expect(inlineIds()).toEqual(["file-browser-up", "file-browser-refresh", "file-browser-upload"]);
    await openFileBrowserMoreMenu();
    // Collapsed icons lead the menu: "New" becomes a sub-menu of File / Folder.
    expect(menuLabels()[0]).toBe("New");
    expect(
      document.querySelector('[data-testid="file-browser-new"]')?.getAttribute("aria-haspopup")
    ).toBe("menu");
  });

  it("keeps Up and Refresh inline however narrow the row is", () => {
    width.value = 20;
    render(buildFileBrowserActions(input()));
    expect(inlineIds()).toEqual(["file-browser-up", "file-browser-refresh"]);
  });

  it("uses distinct glyphs for Up and Upload (#5624)", () => {
    render(buildFileBrowserActions(input({ mode: "session" })));
    const glyph = (id: string) =>
      container.querySelector(`[data-testid="${id}"] svg`)?.getAttribute("class") ?? "";
    expect(glyph("file-browser-up")).toContain("lucide-corner-left-up");
    expect(glyph("file-browser-upload")).toContain("lucide-upload");
    const iconOf = (id: string) =>
      container.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-icon");
    expect(iconOf("file-browser-up")).toBe("corner-left-up");
    expect(iconOf("file-browser-upload")).toBe("upload");
  });

  it("runs Copy path from the menu (#5624)", async () => {
    const onCopyPath = vi.fn();
    render(buildFileBrowserActions(input({ onCopyPath })));
    await openFileBrowserMoreMenu();
    await act(async () => {
      (document.querySelector('[data-testid="file-browser-copy-path"]') as HTMLElement).click();
    });
    expect(onCopyPath).toHaveBeenCalledTimes(1);
  });

  it("keeps the menu right of the row's left edge (#5624)", async () => {
    const realRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const left = (this as HTMLElement).dataset?.testid === "file-browser-actions" ? 57 : 0;
      return {
        width: 0,
        height: 0,
        top: 0,
        left,
        right: left,
        bottom: 0,
        x: left,
        y: 0,
      } as DOMRect;
    };
    try {
      render(buildFileBrowserActions(input()));
      await openFileBrowserMoreMenu();
      const menu = document.querySelector('[data-testid="file-browser-more-menu"]')!;
      expect(menu.getAttribute("data-collision-left")).toBe("57");
    } finally {
      Element.prototype.getBoundingClientRect = realRect;
    }
  });
});

describe("file sort sub-menu (#5671)", () => {
  async function openSortMenu() {
    await openFileBrowserMoreMenu();
    const trigger = document.querySelector<HTMLElement>('[data-testid="file-browser-sort-menu"]')!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
  }

  it("sorts by modified or size and flips the direction", async () => {
    const onSort = vi.fn();
    render(buildFileBrowserActions(input({ onSort, sortInMenu: true })));
    await openSortMenu();
    const modified = document.querySelector<HTMLElement>(
      '[data-testid="file-browser-sort-by-modified"]'
    );
    expect(modified?.getAttribute("role")).toBe("menuitemradio");
    expect(
      document
        .querySelector('[data-testid="file-browser-sort-by-name"]')
        ?.getAttribute("aria-checked")
    ).toBe("true");
    await act(async () => {
      modified!.click();
    });
    expect(onSort).toHaveBeenCalledWith({ key: "modified", dir: "asc" });
    await openSortMenu();
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="file-browser-sort-dir-desc"]')!.click();
    });
    expect(onSort).toHaveBeenLastCalledWith({ key: "name", dir: "desc" });
    await openSortMenu();
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="file-browser-sort-by-size"]')!.click();
    });
    expect(onSort).toHaveBeenLastCalledWith({ key: "size", dir: "asc" });
  });
});

describe("file browser menu state and grouping (#5832)", () => {
  /** Let a menu close and a deferred entry (`opensField`) run. */
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  const el = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it("groups New file / New folder as one 'New ▾' menu button", async () => {
    const onNewFile = vi.fn();
    const onNewFolder = vi.fn();
    render(buildFileBrowserActions(input({ onNewFile, onNewFolder })));
    const trigger = el("file-browser-new")!;
    expect(trigger.getAttribute("aria-label")).toBe("New");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(el("file-browser-new-file")).toBeNull();
    await openFileBrowserMenuButton("file-browser-new");
    const menu = el("file-browser-new-menu")!;
    expect(
      Array.from(menu.querySelectorAll('[role="menuitem"]')).map((m) => m.textContent?.trim())
    ).toEqual(["File", "Folder"]);
    await act(async () => {
      el("file-browser-new-file")!.click();
    });
    await settle();
    expect(onNewFile).toHaveBeenCalledTimes(1);
    await openFileBrowserMenuButton("file-browser-new");
    await act(async () => {
      el("file-browser-new-folder")!.click();
    });
    await settle();
    expect(onNewFolder).toHaveBeenCalledTimes(1);
  });

  it("offers New ▸ File / Folder as a sub-menu once 'New' collapses into '…'", async () => {
    const onNewFolder = vi.fn();
    width.value = 20;
    render(buildFileBrowserActions(input({ onNewFolder })));
    await openFileBrowserMenuButton("file-browser-new");
    expect(el("file-browser-new-menu")).not.toBeNull();
    await act(async () => {
      el("file-browser-new-folder")!.click();
    });
    await settle();
    expect(onNewFolder).toHaveBeenCalledTimes(1);
  });

  it("keeps focus on the field 'New ▸ File' opens, inline or from '…'", async () => {
    const field = document.createElement("input");
    document.body.appendChild(field);
    for (const w of [null, 20]) {
      width.value = w;
      render(buildFileBrowserActions(input({ onNewFile: () => field.focus() })));
      await openFileBrowserMenuButton("file-browser-new");
      await act(async () => {
        el("file-browser-new-file")!.click();
      });
      await settle();
      expect(document.activeElement, String(w)).toBe(field);
      field.blur();
    }
  });

  it("sets the pinned navigation apart from the create / upload icons", () => {
    render(buildFileBrowserActions(input({ mode: "session" })));
    const row = el("file-browser-actions")!;
    const kids = Array.from(row.children).map((c) =>
      c.classList.contains("file-browser__actions-divider")
        ? "|"
        : ((c as HTMLElement).dataset.testid ?? "")
    );
    expect(kids.slice(0, 5)).toEqual([
      "file-browser-up",
      "file-browser-refresh",
      "|",
      "file-browser-new",
      "file-browser-upload",
    ]);
    width.value = 20;
    render(buildFileBrowserActions(input({ mode: "session" })));
    expect(row.querySelector(".file-browser__actions-divider")).toBeNull();
  });

  it("ticks 'Show hidden files' only while it is on", async () => {
    render(buildFileBrowserActions(input({ showHiddenFiles: true })));
    await openFileBrowserMoreMenu();
    const on = el("file-browser-toggle-hidden")!;
    expect(on.getAttribute("role")).toBe("menuitemcheckbox");
    expect(on.getAttribute("aria-checked")).toBe("true");
    expect(on.querySelector(".file-browser__menu-tick svg")).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    render(buildFileBrowserActions(input({ showHiddenFiles: false })));
    await openFileBrowserMoreMenu();
    const off = el("file-browser-toggle-hidden")!;
    expect(off.getAttribute("aria-checked")).toBe("false");
    // The tick slot keeps its room, so the label does not shift.
    expect(off.querySelector(".file-browser__menu-tick")).not.toBeNull();
    expect(off.querySelector(".file-browser__menu-tick svg")).toBeNull();
  });

  it("names 'Go to terminal folder' as a command, not a toggle", async () => {
    render(buildFileBrowserActions(input()));
    await openFileBrowserMoreMenu();
    const cwd = el("file-browser-go-to-cwd")!;
    expect(cwd.getAttribute("role")).toBe("menuitem");
    expect(cwd.textContent?.trim()).toBe("Go to terminal folder");
  });

  it("opens the menu with a muted line naming the folder it acts on", async () => {
    render(buildFileBrowserActions(input()), "/home/user/projects");
    await openFileBrowserMoreMenu();
    const menu = el("file-browser-more-menu")!;
    const heading = el("file-browser-more-menu-folder")!;
    expect(menu.firstElementChild).toBe(heading);
    expect(heading.textContent?.trim()).toBe("projects");
    expect(heading.getAttribute("title")).toBe("/home/user/projects");
    expect(heading.getAttribute("role") ?? "").not.toMatch(/^menuitem/);
    expect(menu.querySelectorAll('[role="separator"]').length).toBe(5);
  });

  it("shows the current column and direction on 'Sort by'", async () => {
    render(
      buildFileBrowserActions(input({ sortInMenu: true, sort: { key: "size", dir: "desc" } }))
    );
    await openFileBrowserMoreMenu();
    const trigger = el("file-browser-sort-menu")!;
    expect(trigger.getAttribute("aria-label")).toBe("Sort by: Size, descending");
    expect(el("file-browser-sort-current")?.textContent).toBe("Size");
    expect(el("file-browser-sort-current")?.querySelector(".lucide-chevron-down")).not.toBeNull();
  });
});
