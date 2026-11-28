/**
 * A bridge click acts like a user's (#6149, TST-004): it waits briefly for the
 * target, then refuses a control a user could not click — disabled,
 * aria-disabled, inert, without a size, or covered at its centre — and names
 * the reason. `force: true` skips the checks, for a test that clicks an
 * aria-disabled control on purpose (an invalid form's Save shows its reasons,
 * #5917). `type` needs an editable element that takes the focus.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";

function setup(html: string): { deps: BridgeDeps; container: HTMLElement } {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const deps: BridgeDeps = {
    root: container,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "data:image/png;base64,AAAA",
    emitEvent: async () => {},
    actionTimeoutMs: 60,
  };
  return { deps, container };
}

const RECT = { left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30, x: 10, y: 10 };

/** Give `el` a box, and make `hit` the element at every point (a real layout). */
function layout(el: Element, hit: () => Element | null, rect = RECT): void {
  el.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
  document.elementFromPoint = vi.fn(hit);
}

const clickOf = (testId: string, force?: boolean) =>
  force === undefined
    ? ({ action: "click", testId } as const)
    : ({ action: "click", testId, force } as const);

describe("bridge click refuses what a user could not click (#6149)", () => {
  const original = document.elementFromPoint;
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.elementFromPoint = original;
  });

  it.each([
    [`<button data-testid="go" disabled>Go</button>`, "disabled"],
    [`<button data-testid="go" aria-disabled="true">Go</button>`, "aria-disabled"],
    [`<div inert><button data-testid="go">Go</button></div>`, "inert"],
    [`<fieldset disabled><button data-testid="go">Go</button></fieldset>`, "disabled"],
  ])("refuses %s and names the reason", async (html, reason) => {
    const { deps, container } = setup(html);
    const handler = vi.fn();
    container.querySelector("button")!.addEventListener("click", handler);
    const res = await dispatchCommand(clickOf("go"), deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain(reason);
    expect(res.error).toContain('data-testid="go"');
    expect(handler).not.toHaveBeenCalled();
  });

  it("clicks an aria-disabled control when the test forces it", async () => {
    const { deps, container } = setup(`<button data-testid="go" aria-disabled="true">Go</button>`);
    const handler = vi.fn();
    container.querySelector("button")!.addEventListener("click", handler);
    const res = await dispatchCommand(clickOf("go", true), deps);
    expect(res).toEqual({ ok: true, action: "click" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses a control covered at its centre, naming what covers it", async () => {
    const { deps, container } = setup(
      `<button data-testid="go">Go</button><div data-testid="scrim" class="scrim"></div>`
    );
    const handler = vi.fn();
    const btn = container.querySelector("button")!;
    btn.addEventListener("click", handler);
    const scrim = container.querySelector(".scrim")!;
    layout(btn, () => scrim);
    const res = await dispatchCommand(clickOf("go"), deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("covered");
    expect(res.error).toContain("scrim");
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts a hit on the target's own content or its label", async () => {
    const { deps, container } = setup(
      `<button data-testid="go"><svg class="icon"></svg>Go</button>` +
        `<label><input type="checkbox" data-testid="box" /> Box</label>`
    );
    const btn = container.querySelector("button")!;
    layout(btn, () => container.querySelector(".icon"));
    expect((await dispatchCommand(clickOf("go"), deps)).ok).toBe(true);
    const box = container.querySelector("input")!;
    layout(box, () => container.querySelector("label"));
    expect((await dispatchCommand(clickOf("box"), deps)).ok).toBe(true);
  });

  it("refuses a control with no size where there is a layout", async () => {
    const { deps, container } = setup(`<button data-testid="go">Go</button>`);
    const btn = container.querySelector("button")!;
    layout(btn, () => btn, { ...RECT, width: 0, height: 0, right: 10, bottom: 10 });
    const res = await dispatchCommand(clickOf("go"), deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no size");
  });

  it("waits for a control that becomes clickable within the poll", async () => {
    const { deps, container } = setup(`<button data-testid="go" aria-disabled="true">Go</button>`);
    const btn = container.querySelector("button")!;
    const handler = vi.fn();
    btn.addEventListener("click", handler);
    setTimeout(() => btn.removeAttribute("aria-disabled"), 15);
    const res = await dispatchCommand(clickOf("go"), { ...deps, actionTimeoutMs: 1000 });
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("waits for a control that mounts within the poll", async () => {
    const { deps, container } = setup(`<div></div>`);
    setTimeout(() => {
      container.innerHTML = `<button data-testid="go">Go</button>`;
    }, 15);
    const res = await dispatchCommand(clickOf("go"), { ...deps, actionTimeoutMs: 1000 });
    expect(res.ok).toBe(true);
  });

  it("still fails, with the reason, when the target never appears", async () => {
    const { deps } = setup(`<div></div>`);
    const res = await dispatchCommand(clickOf("go"), deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no element with data-testid="go"');
  });

  it("applies the same checks to doubleClick, and its force", async () => {
    const { deps, container } = setup(`<button data-testid="go" disabled>Go</button>`);
    const handler = vi.fn();
    container.querySelector("button")!.addEventListener("dblclick", handler);
    const refused = await dispatchCommand({ action: "doubleClick", testId: "go" }, deps);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("disabled");
    const forced = await dispatchCommand(
      { action: "doubleClick", testId: "go", force: true },
      deps
    );
    expect(forced.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("bridge type needs an editable element that takes the focus (#6149)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses the field before it types", async () => {
    const { deps, container } = setup(`<input data-testid="name" />`);
    const input = container.querySelector("input")!;
    const res = await dispatchCommand({ action: "type", testId: "name", text: "hub" }, deps);
    expect(res.ok).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("hub");
  });

  it.each([
    [`<input data-testid="name" disabled />`, "disabled"],
    [`<input data-testid="name" readonly />`, "read-only"],
    [`<div inert><input data-testid="name" /></div>`, "inert"],
  ])("refuses %s", async (html, reason) => {
    const { deps, container } = setup(html);
    const input = container.querySelector("input")!;
    const res = await dispatchCommand({ action: "type", testId: "name", text: "x" }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain(reason);
    expect(input.value).toBe("");
  });

  it("types into a contenteditable element", async () => {
    const { deps, container } = setup(`<div data-testid="note" contenteditable="true"></div>`);
    const div = container.querySelector("div")!;
    const observed: string[] = [];
    div.addEventListener("input", () => observed.push(div.textContent ?? ""));
    const res = await dispatchCommand({ action: "type", testId: "note", text: "hi" }, deps);
    expect(res.ok).toBe(true);
    expect(div.textContent).toBe("hi");
    expect(observed).toEqual(["hi"]);
  });

  it("still refuses an element that is not editable", async () => {
    const { deps } = setup(`<div data-testid="name"></div>`);
    const res = await dispatchCommand({ action: "type", testId: "name", text: "x" }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not editable");
  });
});
