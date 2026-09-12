import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { useDeleteConfirm, DeleteConfirm } from "./useDeleteConfirm";

interface Target {
  id: string;
  name: string;
}

function Harness({
  onConfirm,
  onResult,
}: {
  onConfirm: (target: Target) => void | Promise<void>;
  onResult: (r: DeleteConfirm<Target>) => void;
}) {
  onResult(useDeleteConfirm(onConfirm));
  return null;
}

describe("useDeleteConfirm", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: DeleteConfirm<Target>;
  let onConfirm: ReturnType<typeof vi.fn<(target: Target) => void | Promise<void>>>;

  function render() {
    act(() => {
      root.render(createElement(Harness, { onConfirm, onResult: (r) => (latest = r) }));
    });
  }

  beforeEach(() => {
    onConfirm = vi.fn<(target: Target) => void | Promise<void>>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("starts idle with the dialog closed", () => {
    render();
    expect(latest.pending).toBeNull();
    expect(latest.dialogProps.open).toBe(false);
  });

  it("opens the confirmation for a requested target", () => {
    render();
    act(() => latest.request({ id: "1", name: "Deploy" }));
    expect(latest.pending).toEqual({ id: "1", name: "Deploy" });
    expect(latest.dialogProps.open).toBe(true);
  });

  it("runs onConfirm with the target and closes on confirm", () => {
    render();
    act(() => latest.request({ id: "1", name: "Deploy" }));
    act(() => void latest.confirm());
    expect(onConfirm).toHaveBeenCalledWith({ id: "1", name: "Deploy" });
    expect(latest.pending).toBeNull();
    expect(latest.dialogProps.open).toBe(false);
  });

  it("does not run onConfirm when nothing is pending", () => {
    render();
    let returned: unknown = "sentinel";
    act(() => {
      returned = latest.confirm();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(returned).toBeUndefined();
  });

  it("clears the target on cancel without deleting", () => {
    render();
    act(() => latest.request({ id: "1", name: "Deploy" }));
    act(() => latest.cancel());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(latest.pending).toBeNull();
    expect(latest.dialogProps.open).toBe(false);
  });

  it("returns onConfirm's promise so async confirm state is preserved", async () => {
    let resolveDelete: () => void = () => {};
    onConfirm.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      })
    );
    render();
    act(() => latest.request({ id: "1", name: "Deploy" }));
    let confirmResult: void | Promise<void> = undefined;
    act(() => {
      confirmResult = latest.confirm();
    });
    expect(confirmResult).toBeInstanceOf(Promise);
    await act(async () => {
      resolveDelete();
      await confirmResult;
    });
  });

  it("wires dialogProps.onConfirm/onCancel to confirm/cancel", () => {
    render();
    act(() => latest.request({ id: "2", name: "Backup" }));
    act(() => void latest.dialogProps.onConfirm());
    expect(onConfirm).toHaveBeenCalledWith({ id: "2", name: "Backup" });
    expect(latest.pending).toBeNull();
  });
});
