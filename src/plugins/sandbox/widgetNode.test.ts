/**
 * Tests for status-bar widget descriptor materialisation (#2136): the host
 * rebuilds a sandbox {@link WidgetNode} into DOM through a strict allowlist so a
 * hostile descriptor can never inject executable content into the host page.
 */
import { describe, it, expect } from "vitest";
import { buildWidgetDom } from "./widgetNode";
import type { WidgetNode } from "./protocol";

describe("buildWidgetDom", () => {
  it("builds an allowed tag with text via textContent", () => {
    const el = buildWidgetDom({ tag: "span", text: "42%" });
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("42%");
  });

  it("coerces a disallowed tag to a span", () => {
    const el = buildWidgetDom({ tag: "script", text: "x" });
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("x");
  });

  it("never parses text as HTML (no innerHTML injection)", () => {
    const el = buildWidgetDom({ tag: "span", text: "<img src=x onerror=alert(1)>" });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("applies allowlisted attributes and data-* but drops others", () => {
    const el = buildWidgetDom({
      tag: "span",
      attrs: {
        class: "widget",
        title: "hi",
        "data-x": "1",
        onclick: "alert(1)",
        href: "javascript:alert(1)",
        style: "color:red",
      },
    });
    expect(el.getAttribute("class")).toBe("widget");
    expect(el.getAttribute("title")).toBe("hi");
    expect(el.getAttribute("data-x")).toBe("1");
    expect(el.hasAttribute("onclick")).toBe(false);
    expect(el.hasAttribute("href")).toBe(false);
    expect(el.hasAttribute("style")).toBe(false);
  });

  it("materialises nested children in order", () => {
    const node: WidgetNode = {
      tag: "div",
      children: [
        { tag: "b", text: "bold" },
        { tag: "code", text: "x" },
      ],
    };
    const el = buildWidgetDom(node);
    expect(el.childNodes).toHaveLength(2);
    expect(el.children[0].tagName).toBe("B");
    expect(el.children[0].textContent).toBe("bold");
    expect(el.children[1].tagName).toBe("CODE");
  });

  it("caps nesting depth without throwing", () => {
    // Build a chain deeper than MAX_DEPTH (16).
    let node: WidgetNode = { tag: "span", text: "deep" };
    for (let i = 0; i < 40; i++) node = { tag: "span", children: [node] };
    expect(() => buildWidgetDom(node)).not.toThrow();
  });
});
