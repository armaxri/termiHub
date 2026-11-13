import { afterEach, describe, expect, it } from "vitest";

import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import {
  FORCED_HOVER_ATTR,
  FORCED_HOVER_STYLE_ID,
  clearForcedHover,
  forceHover,
  forcedHoverSelector,
} from "./forcedHover";
import type { ForceHoverResult } from "./protocol";

function deps(): BridgeDeps {
  return { root: document } as unknown as BridgeDeps;
}

function addSheet(css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  return style;
}

describe("forcedHover", () => {
  afterEach(() => {
    clearForcedHover(document);
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("rewrites :hover but leaves look-alike pseudo-classes alone", () => {
    expect(forcedHoverSelector(".row--selected:hover")).toBe(
      `.row--selected[${FORCED_HOVER_ATTR}]`
    );
    expect(forcedHoverSelector(".a:hover .b, .c:hover-ish")).toBe(
      `.a[${FORCED_HOVER_ATTR}] .b, .c:hover-ish`
    );
  });

  it("applies the app's hover rule so the computed style shows it", () => {
    addSheet(
      ".row { background-color: rgb(1, 2, 3); } .row:hover { background-color: rgb(9, 8, 7); }"
    );
    document.body.innerHTML = `<div class="list"><div class="row" data-testid="row"></div></div>`;
    const row = document.querySelector<HTMLElement>("[data-testid=row]")!;
    expect(getComputedStyle(row).backgroundColor).toBe("rgb(1, 2, 3)");

    expect(forceHover(row)).toBe(1);
    expect(getComputedStyle(row).backgroundColor).toBe("rgb(9, 8, 7)");
    // :hover matches the ancestor chain too.
    expect(row.parentElement!.hasAttribute(FORCED_HOVER_ATTR)).toBe(true);

    clearForcedHover(document);
    expect(getComputedStyle(row).backgroundColor).toBe("rgb(1, 2, 3)");
    expect(document.getElementById(FORCED_HOVER_STYLE_ID)).toBeNull();
    expect(document.querySelector(`[${FORCED_HOVER_ATTR}]`)).toBeNull();
  });

  it("keeps the condition of a hover rule inside @media", () => {
    addSheet("@media screen { .x:hover { color: red; } } .y { color: blue; }");
    document.body.innerHTML = `<div data-testid="x" class="x"></div>`;
    expect(forceHover(document.querySelector("[data-testid=x]")!)).toBe(1);
    const text = document.getElementById(FORCED_HOVER_STYLE_ID)!.textContent ?? "";
    expect(text).toContain("@media screen");
    expect(text).toContain(`.x[${FORCED_HOVER_ATTR}]`);
  });

  it("replaces an earlier forced hover", () => {
    addSheet(".a:hover { color: red; }");
    document.body.innerHTML = `<i data-testid="one"></i><i data-testid="two"></i>`;
    forceHover(document.querySelector("[data-testid=one]")!);
    forceHover(document.querySelector("[data-testid=two]")!);
    const one = document.querySelector("[data-testid=one]")!;
    expect(one.hasAttribute(FORCED_HOVER_ATTR)).toBe(false);
    expect(document.querySelectorAll(`#${FORCED_HOVER_STYLE_ID}`)).toHaveLength(1);
  });
});

describe("forceHover command", () => {
  afterEach(() => {
    clearForcedHover(document);
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("hovers by testid and clears without one", async () => {
    addSheet(".t:hover { color: red; }");
    document.body.innerHTML = `<div class="t" data-testid="t"></div>`;
    const on = await dispatchCommand({ action: "forceHover", testId: "t" }, deps());
    expect(on.ok).toBe(true);
    expect((on.value as ForceHoverResult).rules).toBe(1);
    const off = await dispatchCommand({ action: "forceHover" }, deps());
    expect((off.value as ForceHoverResult).rules).toBe(0);
    expect(document.querySelector(`[${FORCED_HOVER_ATTR}]`)).toBeNull();
  });

  it("fails on an unknown testid", async () => {
    const response = await dispatchCommand({ action: "forceHover", testId: "missing" }, deps());
    expect(response.ok).toBe(false);
    expect(response.error).toContain("missing");
  });
});
