/**
 * Unit tests for the shared export/import button pair (UISF-019).
 *
 * These lock in the DOM parity contract the Macro/Workflow/Workspace toolbars
 * rely on: the two icon-only ghost buttons render in export-then-import order
 * with the caller's labels, testids, and disabled state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ExportImportButtons } from "./ExportImportButtons";
import { withTooltip } from "@/test/tooltip";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ExportImportButtons", () => {
  it("renders export then import with labels, testids, and disabled state", () => {
    const onExport = vi.fn();
    const onImport = vi.fn();
    act(() =>
      root.render(
        withTooltip(
          <ExportImportButtons
            onExport={onExport}
            onImport={onImport}
            exportLabel="Export All Macros"
            importLabel="Import Macros"
            exportDisabled
            exportTestId="macro-export-all-btn"
            importTestId="macro-import-btn"
          />
        )
      )
    );
    const exportBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="macro-export-all-btn"]'
    );
    const importBtn = container.querySelector<HTMLButtonElement>('[data-testid="macro-import-btn"]');
    expect(exportBtn).not.toBeNull();
    expect(importBtn).not.toBeNull();
    expect(exportBtn?.getAttribute("aria-label")).toBe("Export All Macros");
    expect(importBtn?.getAttribute("aria-label")).toBe("Import Macros");
    expect(exportBtn?.disabled).toBe(true);
    // Export precedes import in document order.
    expect(
      exportBtn?.compareDocumentPosition(importBtn as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("wires the click handlers", () => {
    const onExport = vi.fn();
    const onImport = vi.fn();
    act(() =>
      root.render(
        withTooltip(
          <ExportImportButtons
            onExport={onExport}
            onImport={onImport}
            exportLabel="Export"
            importLabel="Import"
            exportTestId="exp"
            importTestId="imp"
          />
        )
      )
    );
    act(() => {
      container
        .querySelector('[data-testid="exp"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      container
        .querySelector('[data-testid="imp"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onImport).toHaveBeenCalledTimes(1);
  });
});
