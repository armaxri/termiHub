import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SaveAsConnectionDialog } from "./SaveAsConnectionDialog";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

const entry: SessionHistoryEntry = {
  dedupKey: "ssh:admin@prod:22",
  title: "admin@prod",
  connectionType: "ssh",
  config: { type: "ssh", config: { host: "prod", username: "admin", port: 22 } },
  firstUsed: 1,
  lastUsed: 2,
  useCount: 1,
  pinned: false,
  promoted: false,
};

const folders: ConnectionFolder[] = [{ id: "f1", name: "Work", parentId: null, isExpanded: true }];

describe("SaveAsConnectionDialog", () => {
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

  it("pre-fills the name from the entry and creates a connection on save", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    act(() =>
      root.render(
        <SaveAsConnectionDialog
          entry={entry}
          folders={folders}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      )
    );

    const name = query("save-as-connection-name") as HTMLInputElement;
    expect(name.value).toBe("admin@prod");

    await act(async () => {
      (query("save-as-connection-submit") as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const [connection, dedupKey] = onSave.mock.calls[0] as [SavedConnection, string];
    expect(connection.name).toBe("admin@prod");
    expect(connection.config).toEqual(entry.config);
    expect(dedupKey).toBe("ssh:admin@prod:22");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("rejects an empty name", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    act(() =>
      root.render(
        <SaveAsConnectionDialog
          entry={entry}
          folders={folders}
          onOpenChange={vi.fn()}
          onSave={onSave}
        />
      )
    );

    const name = query("save-as-connection-name") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(name, "   ");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      (query("save-as-connection-submit") as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });
});
