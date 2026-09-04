import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";

// Mock the toast hub so we can assert error toasts without real DOM toasts.
const toastError = vi.fn((_message: unknown, _opts?: unknown) => undefined);
vi.mock("./Toast", () => ({
  toast: {
    error: (message: unknown, opts?: unknown) => toastError(message, opts),
  },
}));

import { Button } from "./Button";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

/** Flush microtasks so awaited promises inside the click handler settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Button async lifecycle", () => {
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

  it("sync onClick still fires and never enters pending", () => {
    const onClick = vi.fn();
    render(
      <Button data-testid="btn" onClick={onClick}>
        Go
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;
    act(() => btn.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
    expect(btn.classList.contains("ui-btn--pending")).toBe(false);
  });

  it("disables and shows a spinner while pending", async () => {
    let resolve!: () => void;
    const onClick = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(
      <Button data-testid="btn" onClick={onClick}>
        Save
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;

    act(() => btn.click());
    expect(btn.disabled).toBe(true);
    expect(btn.classList.contains("ui-btn--pending")).toBe(true);
    const spinner = btn.querySelector(".ui-btn__spinner");
    expect(spinner).toBeTruthy();
    // #2603: the pending spinner is an essential progress cue — the
    // `motion-essential-spinner` marker keeps it pulsing under reduced motion
    // instead of freezing into a static ring.
    expect(spinner?.className).toContain("motion-essential-spinner");

    await act(async () => {
      resolve();
      await Promise.resolve();
    });
  });

  it("shows a success affordance then returns to idle on resolve", async () => {
    const onClick = vi.fn(() => Promise.resolve());
    render(
      <Button data-testid="btn" onClick={onClick}>
        Save
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;

    act(() => btn.click());
    await flush();

    expect(btn.classList.contains("ui-btn--success")).toBe(true);
    expect(btn.classList.contains("ui-btn--pending")).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("returns to idle and fires toast.error on reject", async () => {
    const onClick = vi.fn(() => Promise.reject(new Error("nope")));
    render(
      <Button data-testid="btn" onClick={onClick}>
        Save
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;

    act(() => btn.click());
    await flush();

    expect(btn.disabled).toBe(false);
    expect(btn.classList.contains("ui-btn--pending")).toBe(false);
    expect(btn.classList.contains("ui-btn--success")).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("does not fire toast.error when errorToast is false", async () => {
    const onClick = vi.fn(() => Promise.reject(new Error("nope")));
    render(
      <Button data-testid="btn" onClick={onClick} errorToast={false}>
        Save
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;

    act(() => btn.click());
    await flush();

    expect(toastError).not.toHaveBeenCalled();
  });

  it("ignores repeat clicks while pending", async () => {
    let resolve!: () => void;
    const onClick = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(
      <Button data-testid="btn" onClick={onClick}>
        Save
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;

    act(() => btn.click());
    act(() => btn.click());
    expect(onClick).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve();
      await Promise.resolve();
    });
  });
});
