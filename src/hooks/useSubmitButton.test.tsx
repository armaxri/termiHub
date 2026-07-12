/**
 * Tests for useSubmitButton (#1414): one gate + one async Button lifecycle for
 * both the Enter (form submit) and click entry points of a form's primary
 * action.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Button } from "@/components/ui/Button";
import { useSubmitButton } from "./useSubmitButton";

function Harness({
  canSubmit,
  action,
}: {
  canSubmit: boolean;
  action: () => void | Promise<void>;
}) {
  const { formProps, submitProps } = useSubmitButton(canSubmit, action);
  return (
    <form data-testid="form" {...formProps}>
      <input />
      <Button {...submitProps} pendingLabel="Working…" data-testid="submit">
        Go
      </Button>
    </form>
  );
}

/** A promise whose resolution the test controls, to freeze the pending state. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function get<T extends HTMLElement>(testId: string): T {
  return container.querySelector<T>(`[data-testid="${testId}"]`)!;
}

async function fireSubmit() {
  await act(async () => {
    get<HTMLFormElement>("form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
  });
  await flush();
}

async function fireClick() {
  await act(async () => {
    get<HTMLButtonElement>("submit").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
  });
  await flush();
}

function isPending(button: HTMLButtonElement): boolean {
  return (
    button.classList.contains("ui-btn--pending") &&
    button.getAttribute("aria-busy") === "true" &&
    button.textContent?.includes("Working…") === true
  );
}

describe("useSubmitButton (#1414)", () => {
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

  it("drives the async pending affordance on a click", async () => {
    const gate = deferred();
    const action = vi.fn(() => gate.promise);
    await act(async () => root.render(<Harness canSubmit action={action} />));

    await fireClick();

    expect(action).toHaveBeenCalledTimes(1);
    expect(isPending(get<HTMLButtonElement>("submit"))).toBe(true);
    gate.resolve();
  });

  it("drives the SAME pending affordance on Enter (form submit)", async () => {
    const gate = deferred();
    const action = vi.fn(() => gate.promise);
    await act(async () => root.render(<Harness canSubmit action={action} />));

    await fireSubmit();

    expect(action).toHaveBeenCalledTimes(1);
    expect(isPending(get<HTMLButtonElement>("submit"))).toBe(true);
    gate.resolve();
  });

  it("shares one gate: an invalid form runs neither Enter nor click", async () => {
    const action = vi.fn();
    await act(async () => root.render(<Harness canSubmit={false} action={action} />));

    // The single gate disables the button…
    expect(get<HTMLButtonElement>("submit").disabled).toBe(true);
    // …and blocks both entry points.
    await fireSubmit();
    await fireClick();
    expect(action).not.toHaveBeenCalled();
  });

  it("prevents native double submission on click", async () => {
    const action = vi.fn(() => Promise.resolve());
    await act(async () => root.render(<Harness canSubmit action={action} />));

    // A real click must not additionally fire a native form submit (which would
    // double-run the action).
    await fireClick();
    await flush();
    expect(action).toHaveBeenCalledTimes(1);
  });
});
