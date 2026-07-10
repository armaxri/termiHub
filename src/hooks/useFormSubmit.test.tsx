/**
 * Tests for useFormSubmit (#1341): prevents the default submit and runs the
 * action only when canSubmit is true.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useFormSubmit } from "./useFormSubmit";

function Harness({ canSubmit, action }: { canSubmit: boolean; action: () => void }) {
  const onSubmit = useFormSubmit(canSubmit, action);
  return (
    <form data-testid="form" onSubmit={onSubmit}>
      <input />
    </form>
  );
}

let container: HTMLDivElement;
let root: Root;

function submit(): boolean {
  const form = container.querySelector<HTMLFormElement>('[data-testid="form"]')!;
  const ev = new Event("submit", { bubbles: true, cancelable: true });
  act(() => {
    form.dispatchEvent(ev);
  });
  return ev.defaultPrevented;
}

describe("useFormSubmit (#1341)", () => {
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

  it("runs the action and prevents default when submittable", () => {
    const action = vi.fn();
    act(() => root.render(<Harness canSubmit action={action} />));
    const prevented = submit();
    expect(action).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it("prevents default but does not run the action when not submittable", () => {
    const action = vi.fn();
    act(() => root.render(<Harness canSubmit={false} action={action} />));
    const prevented = submit();
    expect(action).not.toHaveBeenCalled();
    expect(prevented).toBe(true);
  });
});
