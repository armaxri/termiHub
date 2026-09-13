import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SaveCopyDialog, type SaveCopyDialogProps } from "./SaveCopyDialog";

let container: HTMLDivElement;
let root: Root;

/** SaveCopyDialog renders through a Radix Dialog portal, so query the document. */
function queryDoc(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function pathInput(): HTMLInputElement {
  return queryDoc("save-copy-input") as HTMLInputElement;
}

function setPath(value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(pathInput(), value);
    pathInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function handlers() {
  return { onSubmit: vi.fn(), onCancel: vi.fn() };
}

function render(props: Partial<SaveCopyDialogProps> = {}, h = handlers()) {
  const merged: SaveCopyDialogProps = {
    open: true,
    defaultPath: "/home/user/report.log.copy",
    busy: false,
    onSubmit: h.onSubmit,
    onCancel: h.onCancel,
    ...props,
  };
  act(() => {
    root.render(<SaveCopyDialog {...merged} />);
  });
  return h;
}

describe("SaveCopyDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing while closed", () => {
    render({ open: false });
    expect(queryDoc("save-copy-dialog")).toBeNull();
  });

  it("renders the title, prompt, and default path when open", () => {
    render();
    const dialog = queryDoc("save-copy-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Save a copy");
    expect(dialog?.textContent).toContain("read-only");
    expect(pathInput().value).toBe("/home/user/report.log.copy");
  });

  it("submits the trimmed path via the confirm button", () => {
    const h = render();
    setPath("  /srv/out.log  ");
    act(() => queryDoc("save-copy-submit")?.click());
    expect(h.onSubmit).toHaveBeenCalledWith("/srv/out.log");
  });

  it("submits on Enter in the path field", () => {
    const h = render();
    setPath("/tmp/copy.txt");
    act(() => {
      pathInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(h.onSubmit).toHaveBeenCalledWith("/tmp/copy.txt");
  });

  it("disables submit and ignores confirm when the path is blank", () => {
    const h = render();
    setPath("   ");
    expect((queryDoc("save-copy-submit") as HTMLButtonElement).disabled).toBe(true);
    act(() => queryDoc("save-copy-submit")?.click());
    expect(h.onSubmit).not.toHaveBeenCalled();
  });

  it("shows a saving label, disables the controls, and blocks submit while busy", () => {
    const h = render({ busy: true });
    expect(queryDoc("save-copy-submit")?.textContent).toContain("Saving…");
    expect((queryDoc("save-copy-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(pathInput().disabled).toBe(true);
    act(() => queryDoc("save-copy-submit")?.click());
    expect(h.onSubmit).not.toHaveBeenCalled();
  });

  it("cancels via the cancel button", () => {
    const h = render();
    act(() => queryDoc("save-copy-cancel")?.click());
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("resets an edited path back to the suggestion when reopened", () => {
    const h = render({ open: true, defaultPath: "/a/first.copy" });
    setPath("/edited/by/user");
    expect(pathInput().value).toBe("/edited/by/user");
    // Close, then reopen with a fresh suggestion.
    render({ open: false, defaultPath: "/a/first.copy" }, h);
    render({ open: true, defaultPath: "/b/second.copy" }, h);
    expect(pathInput().value).toBe("/b/second.copy");
  });
});
