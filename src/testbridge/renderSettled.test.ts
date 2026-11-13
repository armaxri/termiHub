import { describe, it, expect, beforeEach } from "vitest";
import { renderSettled } from "./renderSettled";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import type { RenderSettledResult } from "./protocol";

/** Give an element a fake on-screen box (jsdom lays out nothing). */
function fakeBox(el: Element | null, width = 100, height = 20, x = 0, y = 0): void {
  if (!el) throw new Error("fixture element missing");
  el.getBoundingClientRect = () =>
    ({
      x,
      y,
      left: x,
      top: y,
      width,
      height,
      right: x + width,
      bottom: y + height,
    }) as unknown as DOMRect;
}

function mount(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

const q = (root: ParentNode, sel: string): Element | null => root.querySelector(sel);

describe("renderSettled", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("is settled when the expected element is visible and nothing is loading", async () => {
    const root = mount(`<form data-testid="editor"><input data-testid="name" /></form>`);
    fakeBox(q(root, '[data-testid="editor"]'));
    fakeBox(q(root, '[data-testid="name"]'));
    const res = await renderSettled(root, { testId: "name", scopeTestId: "editor" });
    expect(res).toMatchObject({ settled: true, reasons: [], busy: [], mutations: 0 });
  });

  it("is not settled while a lazy-load fallback is visible", async () => {
    const root = mount(
      `<div class="split-view__lazy-fallback"><svg class="ui-spinner"></svg></div>` +
        `<input data-testid="name" />`
    );
    fakeBox(q(root, ".split-view__lazy-fallback"));
    fakeBox(q(root, '[data-testid="name"]'));
    const res = await renderSettled(root, { testId: "name" });
    expect(res.settled).toBe(false);
    expect(res.reasons.join(" ")).toContain("loading placeholder");
    expect(res.reasons.join(" ")).toContain("split-view__lazy-fallback");
  });

  it("ignores a fallback that is not visible (another tab's mounted panel)", async () => {
    const root = mount(
      `<div class="settings-panel__lazy-fallback"></div><input data-testid="name" />`
    );
    fakeBox(q(root, '[data-testid="name"]'));
    const res = await renderSettled(root, { testId: "name" });
    expect(res.settled).toBe(true);
  });

  it("reports the expected element missing or hidden", async () => {
    const root = mount(`<input data-testid="hidden" />`);
    const missing = await renderSettled(root, { testId: "name" });
    expect(missing.reasons).toEqual(["name is not in the page"]);
    const hidden = await renderSettled(root, { testId: "hidden" });
    expect(hidden.reasons).toEqual(["hidden is in the page but not visible"]);
  });

  it("passes when any of several same-testid elements is visible", async () => {
    const root = mount(`<input data-testid="name" /><input data-testid="name" />`);
    fakeBox(root.querySelectorAll('[data-testid="name"]')[1]);
    const res = await renderSettled(root, { testId: "name" });
    expect(res.settled).toBe(true);
  });

  it("blocks on a spinner inside the scope but only lists one outside it", async () => {
    const root = mount(
      `<div data-testid="editor"><svg class="ui-spinner"></svg></div>` +
        `<button data-testid="badge" aria-busy="true"></button>`
    );
    fakeBox(q(root, '[data-testid="editor"]'));
    fakeBox(q(root, ".ui-spinner"));
    fakeBox(q(root, '[data-testid="badge"]'));
    const res = await renderSettled(root, { scopeTestId: "editor" });
    expect(res.settled).toBe(false);
    expect(res.reasons).toEqual(["a busy indicator is visible in editor (.ui-spinner)"]);
    expect(res.busy).toEqual([".ui-spinner", '[data-testid="badge"]']);

    const unscoped = await renderSettled(root, {});
    expect(unscoped.settled).toBe(true);
    expect(unscoped.busy).toHaveLength(2);
  });

  it("counts an off-screen placeholder as not visible", async () => {
    const root = mount(`<div class="row-skeleton"></div>`);
    fakeBox(q(root, ".row-skeleton"), 100, 20, 5000, 5000);
    const res = await renderSettled(root, {});
    expect(res.settled).toBe(true);
  });

  it("is not settled when the DOM changes during the idle frames", async () => {
    const root = mount(`<div data-testid="list"></div>`);
    const list = q(root, '[data-testid="list"]') as Element;
    const pending = renderSettled(root, { frames: 2 });
    list.appendChild(document.createElement("span"));
    const res = await pending;
    expect(res.settled).toBe(false);
    expect(res.mutations).toBeGreaterThan(0);
    expect(res.reasons.join(" ")).toContain("changed during the 2 idle frames");
  });

  it("ignores changes inside a terminal", async () => {
    const root = mount(`<div class="xterm"><div class="xterm-rows"></div></div>`);
    const rows = q(root, ".xterm-rows") as Element;
    const pending = renderSettled(root, {});
    rows.appendChild(document.createElement("div"));
    const res = await pending;
    expect(res.mutations).toBe(0);
    expect(res.settled).toBe(true);
  });

  it("is not settled while web fonts are loading", async () => {
    const root = mount(``);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { status: "loading" },
    });
    try {
      const res = await renderSettled(root, {});
      expect(res.fonts).toBe("loading");
      expect(res.reasons).toEqual(["web fonts are still loading"]);
    } finally {
      delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });

  it("is reachable through the dispatcher", async () => {
    const root = mount(`<input data-testid="name" />`);
    fakeBox(q(root, '[data-testid="name"]'));
    const deps = { root } as unknown as BridgeDeps;
    const res = await dispatchCommand({ action: "renderSettled", testId: "name" }, deps);
    expect(res.ok).toBe(true);
    expect((res.value as RenderSettledResult).settled).toBe(true);
  });
});
