/**
 * Shared Menu primitive (UISF2-008, #4383): token-styled skins over Radix
 * ContextMenu / DropdownMenu. The item parts read the menu kind from the
 * enclosing content, so one item tree renders in either family.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { checkA11y } from "@/test/axe";
import {
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuCheckboxItem,
  MenuItem,
  MenuItemIndicator,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "./Menu";

let container: HTMLDivElement;
let root: Root;

const q = <T extends HTMLElement = HTMLElement>(testId: string) =>
  document.querySelector<T>(`[data-testid="${testId}"]`);

/** Always-open, non-modal dropdown hosting `children`. */
function OpenDropdown({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenuRoot open modal={false}>
      <DropdownMenuTrigger aria-label="Actions">⋯</DropdownMenuTrigger>
      <DropdownMenuContent data-testid="menu">{children}</DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ui/Menu", () => {
  it("renders the dropdown surface with the shared skin, portaled to the body", () => {
    act(() =>
      root.render(
        <OpenDropdown>
          <MenuItem data-testid="item">Rename</MenuItem>
        </OpenDropdown>
      )
    );
    const menu = q("menu")!;
    expect(menu).not.toBeNull();
    expect(menu.classList.contains("ui-menu__content")).toBe(true);
    expect(container.contains(menu)).toBe(false);
    expect(q("item")!.classList.contains("ui-menu__item")).toBe(true);
    expect(q("item")!.getAttribute("role")).toBe("menuitem");
  });

  it("appends a caller className and the wide width modifier", () => {
    act(() =>
      root.render(
        <DropdownMenuRoot open modal={false}>
          <DropdownMenuTrigger aria-label="Actions" />
          <DropdownMenuContent data-testid="menu" width="wide" className="extra">
            <MenuItem>One</MenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      )
    );
    const cls = q("menu")!.classList;
    expect(cls.contains("ui-menu__content")).toBe(true);
    expect(cls.contains("ui-menu__content--wide")).toBe(true);
    expect(cls.contains("extra")).toBe(true);
  });

  it("renders a danger item with the danger modifier", () => {
    act(() =>
      root.render(
        <OpenDropdown>
          <MenuItem danger data-testid="del">
            Delete
          </MenuItem>
          <MenuItem data-testid="plain">Rename</MenuItem>
        </OpenDropdown>
      )
    );
    expect(q("del")!.classList.contains("ui-menu__item--danger")).toBe(true);
    expect(q("plain")!.classList.contains("ui-menu__item--danger")).toBe(false);
  });

  it("renders icon, label, hint and shortcut in order", () => {
    act(() =>
      root.render(
        <OpenDropdown>
          <MenuItem
            data-testid="row"
            icon={<svg data-testid="icon" />}
            hint="current"
            shortcut="⌘,"
          >
            Settings
          </MenuItem>
        </OpenDropdown>
      )
    );
    const row = q("row")!;
    expect(row.firstElementChild).toBe(q("icon"));
    expect(row.textContent).toBe("Settingscurrent⌘,");
    expect(row.querySelector(".ui-menu__hint")!.textContent).toBe("current");
    expect(row.querySelector(".ui-menu__shortcut")!.textContent).toBe("⌘,");
  });

  it("omits the shortcut and hint slots when empty", () => {
    act(() =>
      root.render(
        <OpenDropdown>
          <MenuItem data-testid="row" shortcut={null} hint="">
            Settings
          </MenuItem>
        </OpenDropdown>
      )
    );
    expect(q("row")!.querySelector(".ui-menu__shortcut")).toBeNull();
    expect(q("row")!.querySelector(".ui-menu__hint")).toBeNull();
  });

  it("renders a skinned separator and label", () => {
    act(() =>
      root.render(
        <OpenDropdown>
          <MenuLabel data-testid="label">Section</MenuLabel>
          <MenuItem>One</MenuItem>
          <MenuSeparator data-testid="sep" />
          <MenuItem>Two</MenuItem>
        </OpenDropdown>
      )
    );
    const sep = q("sep")!;
    expect(sep.classList.contains("ui-menu__separator")).toBe(true);
    expect(sep.getAttribute("role")).toBe("separator");
    expect(q("label")!.classList.contains("ui-menu__label")).toBe(true);
  });

  it("fires onSelect for an item", () => {
    const onSelect = vi.fn();
    act(() =>
      root.render(
        <OpenDropdown>
          <MenuItem data-testid="row" onSelect={onSelect}>
            Rename
          </MenuItem>
        </OpenDropdown>
      )
    );
    act(() => q("row")!.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders a checked checkbox item with its indicator", () => {
    act(() =>
      root.render(
        <OpenDropdown>
          <MenuCheckboxItem checked data-testid="check">
            <MenuItemIndicator data-testid="tick">✓</MenuItemIndicator>
            Wrap
          </MenuCheckboxItem>
        </OpenDropdown>
      )
    );
    expect(q("check")!.getAttribute("role")).toBe("menuitemcheckbox");
    expect(q("check")!.getAttribute("aria-checked")).toBe("true");
    expect(q("tick")!.classList.contains("ui-menu__indicator")).toBe(true);
  });

  it("renders a submenu trigger with the sub-trigger skin and chevron", () => {
    act(() =>
      root.render(
        <OpenDropdown>
          <MenuSub>
            <MenuSubTrigger data-testid="sub">Move to</MenuSubTrigger>
            <MenuSubContent>
              <MenuItem>Window 2</MenuItem>
            </MenuSubContent>
          </MenuSub>
        </OpenDropdown>
      )
    );
    const sub = q("sub")!;
    expect(sub.classList.contains("ui-menu__item")).toBe(true);
    expect(sub.classList.contains("ui-menu__sub-trigger")).toBe(true);
    expect(sub.querySelector(".ui-menu__sub-arrow")).not.toBeNull();
  });

  it("renders the same parts inside a context menu", () => {
    act(() =>
      root.render(
        <ContextMenuRoot>
          <ContextMenuTrigger asChild>
            <div data-testid="area">area</div>
          </ContextMenuTrigger>
          <ContextMenuContent data-testid="ctx">
            <MenuItem danger data-testid="ctx-del">
              Delete
            </MenuItem>
            <MenuSeparator />
          </ContextMenuContent>
        </ContextMenuRoot>
      )
    );
    act(() => {
      q("area")!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      );
    });
    expect(q("ctx")!.classList.contains("ui-menu__content")).toBe(true);
    expect(q("ctx-del")!.classList.contains("ui-menu__item--danger")).toBe(true);
  });

  it("throws a clear error when a part is used outside a menu content", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => act(() => root.render(<MenuItem>orphan</MenuItem>))).toThrow(
      /inside a ContextMenuContent or DropdownMenuContent/
    );
    err.mockRestore();
  });

  it("has no a11y violations when open", async () => {
    act(() =>
      root.render(
        <OpenDropdown>
          <MenuLabel>Edit</MenuLabel>
          <MenuItem icon={<svg aria-hidden="true" />} shortcut="⌘R">
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger>Delete</MenuItem>
        </OpenDropdown>
      )
    );
    expect(await checkA11y()).toHaveNoViolations();
  });
});
