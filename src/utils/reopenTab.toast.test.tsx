/**
 * The coalesced reopen toast in the real toast host (#5828): three tab closes
 * render ONE "Closed 3 tabs" toast in the DOM, and its "Reopen all" button
 * restores all three tabs in order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ToastProvider, toast } from "@/components/ui";
import type { ReopenTabPayload } from "@/types/terminal";

const addTab = vi.fn();
vi.mock("@/store/appStore", () => ({
  useAppStore: { getState: () => ({ addTab }) },
}));

import {
  REOPEN_TOAST_ACTION_TEST_ID,
  REOPEN_TOAST_TEST_ID,
  resetReopenToastBatch,
  showReopenToast,
} from "./reopenTab";

let container: HTMLDivElement;
let root: Root;

async function tick(ms = 25) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(predicate: () => boolean, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("waitFor: condition not met within budget");
}

function payload(title: string): ReopenTabPayload {
  return { title, connectionType: "local", config: { type: "local", config: {} } as never };
}

function reopenToasts(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="${REOPEN_TOAST_TEST_ID}"]`)
  ).filter((el) => el.getAttribute("data-removed") !== "true");
}

describe("reopen toast in the toast host (#5828)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    addTab.mockClear();
    resetReopenToastBatch();
    act(() => root.render(<ToastProvider />));
  });

  afterEach(() => {
    toast.dismiss();
    act(() => root.unmount());
    container.remove();
  });

  it("a single close names the tab", async () => {
    act(() => showReopenToast(payload("web-1")));
    await waitFor(() => reopenToasts().length === 1);
    expect(reopenToasts()[0].textContent).toContain("Closed “web-1”");
    expect(reopenToasts()[0].textContent).toContain("Reopen");
  });

  it("three closes show one toast whose Reopen all restores all three in order", async () => {
    act(() => showReopenToast(payload("a")));
    await tick();
    act(() => showReopenToast(payload("b")));
    await tick();
    act(() => showReopenToast(payload("c")));
    await waitFor(() => (reopenToasts()[0]?.textContent ?? "").includes("Closed 3 tabs"));
    expect(reopenToasts()).toHaveLength(1);
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1);
    expect(reopenToasts()[0].textContent).toContain("a, b, c");

    const label = document.querySelector<HTMLElement>(
      `[data-testid="${REOPEN_TOAST_ACTION_TEST_ID}"]`
    );
    expect(label?.textContent).toBe("Reopen all");
    act(() => label!.click());
    expect(addTab.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    await waitFor(() => reopenToasts().length === 0);
  });
});
