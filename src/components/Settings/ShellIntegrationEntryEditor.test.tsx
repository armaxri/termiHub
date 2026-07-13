import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import type { ShellEntry } from "@/types/connection";
import { ShellIntegrationEntryEditor } from "./ShellIntegrationEntryEditor";
import { createEntry } from "./shellIntegrationEntries";

let container: HTMLDivElement;
let root: Root;

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

async function renderEditor(entry: ShellEntry, onSave: (e: ShellEntry) => void): Promise<void> {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ShellIntegrationEntryEditor
          open
          onOpenChange={() => {}}
          entry={entry}
          isNew
          connections={[]}
          onSave={onSave}
        />
      </TooltipProvider>
    );
  });
}

/** Fire a controlled-input change the way React's synthetic event expects. */
function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ShellIntegrationEntryEditor — container preference fields (#1447)", () => {
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

  it("renders the container image and mount-target inputs", async () => {
    await renderEditor(createEntry(), () => {});
    expect(byTestId("shell-integration-entry-container-image")).not.toBeNull();
    expect(byTestId("shell-integration-entry-container-mount")).not.toBeNull();
  });

  it("seeds the inputs from an entry's saved preferences", async () => {
    const entry: ShellEntry = {
      ...createEntry(),
      containerImage: "alpine:3",
      containerMount: "/src",
    };
    await renderEditor(entry, () => {});
    expect((byTestId("shell-integration-entry-container-image") as HTMLInputElement).value).toBe(
      "alpine:3"
    );
    expect((byTestId("shell-integration-entry-container-mount") as HTMLInputElement).value).toBe(
      "/src"
    );
  });

  it("persists edited container image and mount through onSave", async () => {
    const onSave = vi.fn();
    await renderEditor(createEntry(), onSave);

    await act(async () => {
      setInputValue(
        byTestId("shell-integration-entry-container-image") as HTMLInputElement,
        "node:20"
      );
    });
    await act(async () => {
      setInputValue(
        byTestId("shell-integration-entry-container-mount") as HTMLInputElement,
        "/srv"
      );
    });
    await act(async () => {
      byTestId("shell-integration-entry-save")?.click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as ShellEntry;
    expect(saved.containerImage).toBe("node:20");
    expect(saved.containerMount).toBe("/srv");
  });

  it("omits blank container fields (persists undefined, not empty strings)", async () => {
    const onSave = vi.fn();
    await renderEditor(createEntry(), onSave);

    await act(async () => {
      setInputValue(byTestId("shell-integration-entry-container-image") as HTMLInputElement, "   ");
    });
    await act(async () => {
      byTestId("shell-integration-entry-save")?.click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as ShellEntry;
    expect(saved.containerImage).toBeUndefined();
    expect(saved.containerMount).toBeUndefined();
  });
});
