import React, { createContext, useContext } from "react";
import * as RadixContextMenu from "@radix-ui/react-context-menu";
import * as RadixDropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight } from "lucide-react";
import "./ui.css";

/**
 * Shared Menu primitive (UISF2-008): token-styled skins over
 * `@radix-ui/react-context-menu` and `@radix-ui/react-dropdown-menu`.
 *
 * Compose a menu from a root + trigger ({@link ContextMenuRoot} /
 * {@link DropdownMenuRoot}), one content surface ({@link ContextMenuContent} /
 * {@link DropdownMenuContent}, which portals and stacks on the `--z-popover`
 * tier, #4347), and the kind-agnostic parts ({@link MenuItem},
 * {@link MenuSeparator}, {@link MenuLabel}, …). The parts read the menu kind
 * from the enclosing content, so the same item tree renders inside a
 * right-click context menu or a click-opened dropdown.
 *
 * App code must not import the Radix menu packages directly — the
 * `tokenDiscipline` guard enforces that only `ui/` does.
 */

/** Which Radix menu family the enclosing content belongs to. */
type MenuKind = "context" | "dropdown";

const MenuKindContext = createContext<MenuKind | null>(null);

/** Reads the enclosing menu kind; throws when a part is used outside a content. */
function useMenuKind(part: string): MenuKind {
  const kind = useContext(MenuKindContext);
  if (!kind) {
    throw new Error(`${part} must be rendered inside a ContextMenuContent or DropdownMenuContent`);
  }
  return kind;
}

/**
 * Guard against the right-press that opened a context menu selecting an item
 * on its release (#4915). macOS and GTK fire `contextmenu` on the button's
 * *press*, so the release of that same press lands on the already-open menu,
 * and Radix reads a pointerup on an item that saw no pointerdown as a
 * press-drag-release selection — on a terminal that silently picked the first
 * item (Paste). `armed` is true from the moment a context menu opens until the
 * first press inside it or the first release anywhere, and while it is true an
 * item ignores the pointerup. Dropdown menus are unaffected: they open on a
 * left press whose release is meant to be able to select.
 */
interface OpeningReleaseGuard {
  armed: React.MutableRefObject<boolean>;
}

const OpeningReleaseGuardContext = createContext<OpeningReleaseGuard | null>(null);

/**
 * Composes an item's `onPointerUp` with the opening-release guard: inside a
 * context menu, the release of the opening press is swallowed (default
 * prevented, so Radix's own select-on-release handler skips it).
 */
function useGuardedPointerUp(
  onPointerUp: React.PointerEventHandler<HTMLDivElement> | undefined
): React.PointerEventHandler<HTMLDivElement> | undefined {
  const guard = useContext(OpeningReleaseGuardContext);
  if (!guard) return onPointerUp;
  return (event) => {
    onPointerUp?.(event);
    if (guard.armed.current) {
      guard.armed.current = false;
      event.preventDefault();
    }
  };
}

/** Joins class names, skipping falsy entries. */
function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Minimum-width preset for a menu surface. */
export type MenuWidth = "default" | "wide";

/** Props shared by both content surfaces. */
interface MenuContentExtras {
  /** Portal target; defaults to `document.body` (pass a Modal/overlay node to stay inside it). */
  container?: HTMLElement | null;
  /** `wide` raises the minimum width for menus with long rows (language, monitoring). */
  width?: MenuWidth;
}

// ── Roots & triggers ──────────────────────────────────────────────────────

/** Root of a right-click context menu. */
export const ContextMenuRoot = RadixContextMenu.Root;
/** The area that opens the context menu on right-click / long-press. */
export const ContextMenuTrigger = RadixContextMenu.Trigger;
/** Root of a click-opened dropdown menu. */
export const DropdownMenuRoot = RadixDropdownMenu.Root;
/** The control that toggles the dropdown menu. */
export const DropdownMenuTrigger = RadixDropdownMenu.Trigger;

// ── Content surfaces ──────────────────────────────────────────────────────

/** Props for {@link ContextMenuContent}. */
export type ContextMenuContentProps = React.ComponentPropsWithoutRef<
  typeof RadixContextMenu.Content
> &
  MenuContentExtras;

/** The portaled, token-styled surface of a context menu. */
export const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof RadixContextMenu.Content>,
  ContextMenuContentProps
>(function ContextMenuContent(
  { className, container, width, children, onPointerDownCapture, ...rest },
  ref
) {
  // The content mounts when the menu opens, so the guard starts armed.
  const armed = React.useRef(true);
  const guard = React.useMemo<OpeningReleaseGuard>(() => ({ armed }), []);
  React.useEffect(() => {
    // A release that lands outside every item still ends the opening gesture.
    // Bubble phase on window runs after the item's own handler has checked it.
    const disarm = () => {
      armed.current = false;
    };
    window.addEventListener("pointerup", disarm);
    return () => window.removeEventListener("pointerup", disarm);
  }, []);
  return (
    <RadixContextMenu.Portal container={container}>
      <RadixContextMenu.Content
        ref={ref}
        className={cx("ui-menu__content", width === "wide" && "ui-menu__content--wide", className)}
        onPointerDownCapture={(event) => {
          onPointerDownCapture?.(event);
          armed.current = false;
        }}
        {...rest}
      >
        <OpeningReleaseGuardContext.Provider value={guard}>
          <MenuKindContext.Provider value="context">{children}</MenuKindContext.Provider>
        </OpeningReleaseGuardContext.Provider>
      </RadixContextMenu.Content>
    </RadixContextMenu.Portal>
  );
});

/** Props for {@link DropdownMenuContent}. */
export type DropdownMenuContentProps = React.ComponentPropsWithoutRef<
  typeof RadixDropdownMenu.Content
> &
  MenuContentExtras;

/** The portaled, token-styled surface of a dropdown menu. */
export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof RadixDropdownMenu.Content>,
  DropdownMenuContentProps
>(function DropdownMenuContent({ className, container, width, children, ...rest }, ref) {
  return (
    <RadixDropdownMenu.Portal container={container}>
      <RadixDropdownMenu.Content
        ref={ref}
        className={cx("ui-menu__content", width === "wide" && "ui-menu__content--wide", className)}
        {...rest}
      >
        <MenuKindContext.Provider value="dropdown">{children}</MenuKindContext.Provider>
      </RadixDropdownMenu.Content>
    </RadixDropdownMenu.Portal>
  );
});

// ── Items ─────────────────────────────────────────────────────────────────

/** Decorations every item-like row supports. */
interface MenuRowExtras {
  /** Destructive action (Delete, Remove…): rendered in the error colour. */
  danger?: boolean;
  /** Leading icon, rendered before the label. */
  icon?: React.ReactNode;
  /** Trailing keyboard accelerator hint (e.g. "⌘,"); nothing renders when empty. */
  shortcut?: React.ReactNode;
  /** Trailing secondary text (e.g. "current", "— Experimental"); nothing renders when empty. */
  hint?: React.ReactNode;
}

/** Renders a row's icon, label and trailing decorations. */
function RowBody({
  icon,
  children,
  hint,
  shortcut,
}: Pick<MenuRowExtras, "icon" | "hint" | "shortcut"> & { children?: React.ReactNode }) {
  return (
    <>
      {icon}
      {children}
      {hint ? <span className="ui-menu__hint">{hint}</span> : null}
      {shortcut ? <span className="ui-menu__shortcut">{shortcut}</span> : null}
    </>
  );
}

/** Props for {@link MenuItem}. */
export type MenuItemProps = React.ComponentPropsWithoutRef<typeof RadixDropdownMenu.Item> &
  MenuRowExtras;

/** A selectable menu row. Fires `onSelect` and closes the menu (unless prevented). */
export const MenuItem = React.forwardRef<HTMLDivElement, MenuItemProps>(function MenuItem(
  { className, danger, icon, shortcut, hint, children, onPointerUp, ...rest },
  ref
) {
  const kind = useMenuKind("MenuItem");
  const guardedPointerUp = useGuardedPointerUp(onPointerUp);
  const Item = kind === "context" ? RadixContextMenu.Item : RadixDropdownMenu.Item;
  return (
    <Item
      ref={ref}
      className={cx("ui-menu__item", danger && "ui-menu__item--danger", className)}
      onPointerUp={guardedPointerUp}
      {...rest}
    >
      <RowBody icon={icon} hint={hint} shortcut={shortcut}>
        {children}
      </RowBody>
    </Item>
  );
});

/** Props for {@link MenuCheckboxItem}. */
export type MenuCheckboxItemProps = React.ComponentPropsWithoutRef<
  typeof RadixDropdownMenu.CheckboxItem
> &
  MenuRowExtras;

/** A toggleable menu row; pair with {@link MenuItemIndicator} for the tick. */
export const MenuCheckboxItem = React.forwardRef<HTMLDivElement, MenuCheckboxItemProps>(
  function MenuCheckboxItem(
    { className, danger, icon, shortcut, hint, children, onPointerUp, ...rest },
    ref
  ) {
    const kind = useMenuKind("MenuCheckboxItem");
    const guardedPointerUp = useGuardedPointerUp(onPointerUp);
    const Item =
      kind === "context" ? RadixContextMenu.CheckboxItem : RadixDropdownMenu.CheckboxItem;
    return (
      <Item
        ref={ref}
        className={cx("ui-menu__item", danger && "ui-menu__item--danger", className)}
        onPointerUp={guardedPointerUp}
        {...rest}
      >
        <RowBody icon={icon} hint={hint} shortcut={shortcut}>
          {children}
        </RowBody>
      </Item>
    );
  }
);

/** Props for {@link MenuRadioGroup}. */
export type MenuRadioGroupProps = React.ComponentPropsWithoutRef<
  typeof RadixDropdownMenu.RadioGroup
>;

/** A single-choice group of {@link MenuRadioItem}s. */
export const MenuRadioGroup = React.forwardRef<HTMLDivElement, MenuRadioGroupProps>(
  function MenuRadioGroup(props, ref) {
    const kind = useMenuKind("MenuRadioGroup");
    const Group = kind === "context" ? RadixContextMenu.RadioGroup : RadixDropdownMenu.RadioGroup;
    return <Group ref={ref} {...props} />;
  }
);

/** Props for {@link MenuRadioItem}. */
export type MenuRadioItemProps = React.ComponentPropsWithoutRef<
  typeof RadixDropdownMenu.RadioItem
> &
  MenuRowExtras;

/** One choice inside a {@link MenuRadioGroup}; pair with {@link MenuItemIndicator}. */
export const MenuRadioItem = React.forwardRef<HTMLDivElement, MenuRadioItemProps>(
  function MenuRadioItem(
    { className, danger, icon, shortcut, hint, children, onPointerUp, ...rest },
    ref
  ) {
    const kind = useMenuKind("MenuRadioItem");
    const guardedPointerUp = useGuardedPointerUp(onPointerUp);
    const Item = kind === "context" ? RadixContextMenu.RadioItem : RadixDropdownMenu.RadioItem;
    return (
      <Item
        ref={ref}
        className={cx("ui-menu__item", danger && "ui-menu__item--danger", className)}
        onPointerUp={guardedPointerUp}
        {...rest}
      >
        <RowBody icon={icon} hint={hint} shortcut={shortcut}>
          {children}
        </RowBody>
      </Item>
    );
  }
);

/** Props for {@link MenuItemIndicator}. */
export type MenuItemIndicatorProps = React.ComponentPropsWithoutRef<
  typeof RadixDropdownMenu.ItemIndicator
>;

/** Shows its children only while the enclosing checkbox/radio item is checked. */
export const MenuItemIndicator = React.forwardRef<HTMLSpanElement, MenuItemIndicatorProps>(
  function MenuItemIndicator({ className, ...rest }, ref) {
    const kind = useMenuKind("MenuItemIndicator");
    const Indicator =
      kind === "context" ? RadixContextMenu.ItemIndicator : RadixDropdownMenu.ItemIndicator;
    return <Indicator ref={ref} className={cx("ui-menu__indicator", className)} {...rest} />;
  }
);

// ── Structure ─────────────────────────────────────────────────────────────

/** Props for {@link MenuSeparator}. */
export type MenuSeparatorProps = React.ComponentPropsWithoutRef<typeof RadixDropdownMenu.Separator>;

/** A token-styled divider between groups of menu rows. */
export const MenuSeparator = React.forwardRef<HTMLDivElement, MenuSeparatorProps>(
  function MenuSeparator({ className, ...rest }, ref) {
    const kind = useMenuKind("MenuSeparator");
    const Separator = kind === "context" ? RadixContextMenu.Separator : RadixDropdownMenu.Separator;
    return <Separator ref={ref} className={cx("ui-menu__separator", className)} {...rest} />;
  }
);

/** Props for {@link MenuLabel}. */
export type MenuLabelProps = React.ComponentPropsWithoutRef<typeof RadixDropdownMenu.Label>;

/** A non-interactive section heading inside a menu. */
export const MenuLabel = React.forwardRef<HTMLDivElement, MenuLabelProps>(function MenuLabel(
  { className, ...rest },
  ref
) {
  const kind = useMenuKind("MenuLabel");
  const Label = kind === "context" ? RadixContextMenu.Label : RadixDropdownMenu.Label;
  return <Label ref={ref} className={cx("ui-menu__label", className)} {...rest} />;
});

/** Props for {@link MenuGroup}. */
export type MenuGroupProps = React.ComponentPropsWithoutRef<typeof RadixDropdownMenu.Group>;

/** Groups related rows (for assistive tech); no visual chrome of its own. */
export const MenuGroup = React.forwardRef<HTMLDivElement, MenuGroupProps>(
  function MenuGroup(props, ref) {
    const kind = useMenuKind("MenuGroup");
    const Group = kind === "context" ? RadixContextMenu.Group : RadixDropdownMenu.Group;
    return <Group ref={ref} {...props} />;
  }
);

// ── Submenus ──────────────────────────────────────────────────────────────

/** Props for {@link MenuSub}. */
export type MenuSubProps = React.ComponentPropsWithoutRef<typeof RadixDropdownMenu.Sub>;

/** Root of a nested submenu (e.g. "Move to Window ▸"). */
export function MenuSub(props: MenuSubProps): React.ReactElement {
  const kind = useMenuKind("MenuSub");
  return kind === "context" ? (
    <RadixContextMenu.Sub {...props} />
  ) : (
    <RadixDropdownMenu.Sub {...props} />
  );
}

/** Props for {@link MenuSubTrigger}. */
export type MenuSubTriggerProps = React.ComponentPropsWithoutRef<
  typeof RadixDropdownMenu.SubTrigger
> &
  Pick<MenuRowExtras, "icon" | "hint">;

/** The row that opens a {@link MenuSubContent}; renders a trailing chevron. */
export const MenuSubTrigger = React.forwardRef<HTMLDivElement, MenuSubTriggerProps>(
  function MenuSubTrigger({ className, icon, hint, children, ...rest }, ref) {
    const kind = useMenuKind("MenuSubTrigger");
    const Trigger = kind === "context" ? RadixContextMenu.SubTrigger : RadixDropdownMenu.SubTrigger;
    return (
      <Trigger ref={ref} className={cx("ui-menu__item ui-menu__sub-trigger", className)} {...rest}>
        <RowBody icon={icon} hint={hint}>
          {children}
        </RowBody>
        <ChevronRight size={14} className="ui-menu__sub-arrow" aria-hidden="true" />
      </Trigger>
    );
  }
);

/** Props for {@link MenuSubContent}. */
export type MenuSubContentProps = React.ComponentPropsWithoutRef<
  typeof RadixDropdownMenu.SubContent
> &
  MenuContentExtras;

/** The portaled surface of a submenu, styled like its parent content. */
export const MenuSubContent = React.forwardRef<HTMLDivElement, MenuSubContentProps>(
  function MenuSubContent({ className, container, width, ...rest }, ref) {
    const kind = useMenuKind("MenuSubContent");
    const classes = cx("ui-menu__content", width === "wide" && "ui-menu__content--wide", className);
    return kind === "context" ? (
      <RadixContextMenu.Portal container={container}>
        <RadixContextMenu.SubContent ref={ref} className={classes} {...rest} />
      </RadixContextMenu.Portal>
    ) : (
      <RadixDropdownMenu.Portal container={container}>
        <RadixDropdownMenu.SubContent ref={ref} className={classes} {...rest} />
      </RadixDropdownMenu.Portal>
    );
  }
);
