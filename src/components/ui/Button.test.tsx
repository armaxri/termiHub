import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Button } from "./Button";
import { frontendLog } from "@/utils/frontendLog";

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("Button", () => {
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

  it("renders with the base class and default primary/md variant", () => {
    render(<Button data-testid="btn">Click</Button>);
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.classList.contains("ui-btn")).toBe(true);
    expect(btn.classList.contains("ui-btn--primary")).toBe(true);
    expect(btn.textContent).toContain("Click");
    expect(btn.type).toBe("button");
  });

  it.each([
    ["primary", "ui-btn--primary"],
    ["secondary", "ui-btn--secondary"],
    ["ghost", "ui-btn--ghost"],
    ["danger", "ui-btn--danger"],
  ] as const)("applies the %s variant class", (variant, expectedClass) => {
    render(
      <Button data-testid="btn" variant={variant}>
        X
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;
    expect(btn.classList.contains(expectedClass)).toBe(true);
  });

  it("applies the sm size modifier and omits it for md", () => {
    render(
      <Button data-testid="sm" size="sm">
        S
      </Button>
    );
    expect(document.querySelector('[data-testid="sm"]')!.classList.contains("ui-btn--sm")).toBe(
      true
    );

    render(
      <Button data-testid="md" size="md">
        M
      </Button>
    );
    expect(document.querySelector('[data-testid="md"]')!.classList.contains("ui-btn--sm")).toBe(
      false
    );
  });

  it("applies the xs size modifier and omits the other size modifiers", () => {
    render(
      <Button data-testid="xs" size="xs">
        X
      </Button>
    );
    const xs = document.querySelector('[data-testid="xs"]')!;
    expect(xs.classList.contains("ui-btn--xs")).toBe(true);
    expect(xs.classList.contains("ui-btn--sm")).toBe(false);

    // sm and md must never pick up the xs modifier.
    render(
      <Button data-testid="sm2" size="sm">
        S
      </Button>
    );
    expect(document.querySelector('[data-testid="sm2"]')!.classList.contains("ui-btn--xs")).toBe(
      false
    );

    render(
      <Button data-testid="md2" size="md">
        M
      </Button>
    );
    expect(document.querySelector('[data-testid="md2"]')!.classList.contains("ui-btn--xs")).toBe(
      false
    );
  });

  it("applies the full-width modifier when fullWidth is set", () => {
    render(
      <Button data-testid="btn" fullWidth>
        Wide
      </Button>
    );
    expect(document.querySelector('[data-testid="btn"]')!.classList.contains("ui-btn--full")).toBe(
      true
    );
  });

  it("is disabled and does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(
      <Button data-testid="btn" disabled onClick={onClick}>
        No
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    act(() => btn.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("fires onClick when clicked", () => {
    const onClick = vi.fn();
    render(
      <Button data-testid="btn" onClick={onClick}>
        Go
      </Button>
    );
    act(() => (document.querySelector('[data-testid="btn"]') as HTMLElement).click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("forwards a ref to the underlying button element", () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <Button data-testid="btn" ref={ref}>
        Ref
      </Button>
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current).toBe(document.querySelector('[data-testid="btn"]'));
  });

  it("applies the icon-only modifier when iconOnly is set and omits it otherwise", () => {
    render(
      <Button data-testid="icon" iconOnly aria-label="Play">
        <span />
      </Button>
    );
    expect(
      document.querySelector('[data-testid="icon"]')!.classList.contains("ui-btn--icon-only")
    ).toBe(true);

    render(
      <Button data-testid="plain" aria-label="Play">
        <span />
      </Button>
    );
    expect(
      document.querySelector('[data-testid="plain"]')!.classList.contains("ui-btn--icon-only")
    ).toBe(false);
  });

  it("warns via frontendLog when an icon-only Button has no accessible name", () => {
    render(
      <Button data-testid="anon" iconOnly>
        <span />
      </Button>
    );
    expect(frontendLog).toHaveBeenCalledWith("ui_button", expect.stringContaining("accessible"));
  });

  it("does not warn when the icon-only Button has an accessible name", () => {
    render(
      <Button data-testid="named" iconOnly aria-label="Play">
        <span />
      </Button>
    );
    expect(frontendLog).not.toHaveBeenCalled();

    render(
      <Button data-testid="titled" iconOnly title="Play">
        <span />
      </Button>
    );
    expect(frontendLog).not.toHaveBeenCalled();
  });

  it("spreads native button props such as type and aria-label", () => {
    render(
      <Button data-testid="btn" type="submit" aria-label="Submit form">
        S
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;
    expect(btn.type).toBe("submit");
    expect(btn.getAttribute("aria-label")).toBe("Submit form");
  });
});

/**
 * The native form-submit bridge (#1469): a `type="submit"` Button with an
 * `onClick` locates its owning `<form>` and drives its own async lifecycle on
 * native submission (Enter), so Enter and click share ONE code path and ONE
 * gate — the Button's `disabled` prop. This generalises what `useSubmitButton`
 * (#1414) did per-form into the primitive itself.
 */
describe("Button — native form submit bridge (#1469)", () => {
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
    vi.clearAllMocks();
  });

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  function q<T extends HTMLElement>(testId: string): T {
    return container.querySelector<T>(`[data-testid="${testId}"]`)!;
  }

  async function mount(ui: React.ReactElement) {
    await act(async () => {
      root.render(ui);
    });
    await flush();
  }

  async function fireSubmit(formTestId: string) {
    await act(async () => {
      q<HTMLFormElement>(formTestId).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
    await flush();
  }

  async function fireClick(buttonTestId: string) {
    await act(async () => {
      q<HTMLButtonElement>(buttonTestId).dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });
    await flush();
  }

  function isPending(button: HTMLButtonElement): boolean {
    return (
      button.classList.contains("ui-btn--pending") && button.getAttribute("aria-busy") === "true"
    );
  }

  it("drives the async pending lifecycle when the enclosing form is submitted (Enter)", async () => {
    const gate = deferred();
    const action = vi.fn(() => gate.promise);
    await mount(
      <form data-testid="f">
        <input />
        <Button type="submit" onClick={action} pendingLabel="Working…" data-testid="b">
          Go
        </Button>
      </form>
    );

    await fireSubmit("f");

    expect(action).toHaveBeenCalledTimes(1);
    expect(isPending(q<HTMLButtonElement>("b"))).toBe(true);
    gate.resolve();
  });

  it("drives the SAME pending lifecycle on a click", async () => {
    const gate = deferred();
    const action = vi.fn(() => gate.promise);
    await mount(
      <form data-testid="f">
        <Button type="submit" onClick={action} pendingLabel="Working…" data-testid="b">
          Go
        </Button>
      </form>
    );

    await fireClick("b");

    expect(action).toHaveBeenCalledTimes(1);
    expect(isPending(q<HTMLButtonElement>("b"))).toBe(true);
    gate.resolve();
  });

  it("does not double-run the action on click (native re-submit prevented)", async () => {
    const action = vi.fn(() => Promise.resolve());
    await mount(
      <form data-testid="f">
        <Button type="submit" onClick={action} data-testid="b">
          Go
        </Button>
      </form>
    );

    await fireClick("b");
    await flush();

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("gates BOTH Enter and click through the single disabled prop", async () => {
    const action = vi.fn(() => Promise.resolve());
    await mount(
      <form data-testid="f">
        <input />
        <Button type="submit" disabled onClick={action} data-testid="b">
          Go
        </Button>
      </form>
    );

    expect(q<HTMLButtonElement>("b").disabled).toBe(true);
    await fireSubmit("f"); // Enter: bridge honours the disabled gate
    await act(async () => q<HTMLButtonElement>("b").click()); // native click: no-op when disabled
    await flush();

    expect(action).not.toHaveBeenCalled();
  });

  it("honours the form= attribute for a Button rendered outside its form", async () => {
    const gate = deferred();
    const action = vi.fn(() => gate.promise);
    await mount(
      <>
        <form id="ext-form" data-testid="f">
          <input />
        </form>
        <Button type="submit" form="ext-form" onClick={action} data-testid="b">
          Go
        </Button>
      </>
    );

    await fireSubmit("f");

    expect(action).toHaveBeenCalledTimes(1);
    expect(isPending(q<HTMLButtonElement>("b"))).toBe(true);
    gate.resolve();
  });

  it("leaves a submit Button WITHOUT onClick as a plain native control (no recursion)", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    await mount(
      <form data-testid="f" onSubmit={onSubmit}>
        <input />
        <Button type="submit" data-testid="b">
          Go
        </Button>
      </form>
    );

    // Must neither recurse nor throw; the form's own onSubmit still fires exactly once.
    await fireSubmit("f");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("a non-submit Button never intercepts form submission", async () => {
    const action = vi.fn(() => Promise.resolve());
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    await mount(
      <form data-testid="f" onSubmit={onSubmit}>
        <input />
        <Button onClick={action} data-testid="b">
          Go
        </Button>
      </form>
    );

    await fireSubmit("f");
    expect(action).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
