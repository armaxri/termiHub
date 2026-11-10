/** The modifier/key fields a context-menu shortcut check needs. */
interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * Whether a keydown is the "open context menu" shortcut (#4559, #5182): the
 * ContextMenu (Menu) key, or Shift+F10 with no other modifier.
 */
export function isContextMenuShortcut(e: KeyLike): boolean {
  if (e.key === "ContextMenu") return true;
  return e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/**
 * Open `el`'s context menu from the keyboard by synthesizing a `contextmenu`
 * event anchored at its bottom-left. WKWebView on macOS has no Menu key and
 * does not turn Shift+F10 into a `contextmenu` event, so the element does it
 * itself. Call `preventDefault` on the keydown first so engines that *do*
 * translate the key do not fire a second, native `contextmenu`.
 */
export function openContextMenuFromKeyboard(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(16, rect.width / 2),
      clientY: rect.bottom,
    })
  );
}
