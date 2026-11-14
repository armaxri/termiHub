/**
 * A flat `@/components/ui` double for TerminalView suites (#5756).
 *
 * Tooltips pass their child through, Button is a plain `<button>`, and the
 * dropdown menu renders its rows inline (each `MenuItem` a `<button>` whose
 * click fires `onSelect`), so a suite can click the toolbar's "…" menu actions
 * without driving Radix in jsdom. The real menu is covered by
 * `TerminalToolbarMore.test.tsx`.
 *
 * Use from a `vi.mock` factory:
 * `vi.mock("@/components/ui", async () => (await import("@/test/terminalViewUiMock")).terminalViewUiMock());`
 */
import React from "react";
import { vi } from "vitest";

interface MockButtonProps {
  icon?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  [key: string]: unknown;
}

/** Strips the Button primitive's own props and renders a plain button. */
const Button = React.forwardRef<HTMLButtonElement, MockButtonProps>(function Button(
  {
    icon,
    children,
    className,
    variant: _variant,
    size: _size,
    iconOnly: _iconOnly,
    fullWidth: _fullWidth,
    pendingLabel: _pendingLabel,
    errorToast: _errorToast,
    ...rest
  },
  ref
) {
  return (
    <button ref={ref} className={["ui-btn", className].filter(Boolean).join(" ")} {...rest}>
      {icon as React.ReactNode}
      {children as React.ReactNode}
    </button>
  );
});

interface MockMenuItemProps {
  icon?: React.ReactNode;
  shortcut?: React.ReactNode;
  children?: React.ReactNode;
  onSelect?: () => void;
  [key: string]: unknown;
}

/** A menu row as a button; the shortcut renders in a `ui-menu__shortcut` span. */
function MenuItem({ icon, shortcut, children, onSelect, ...rest }: MockMenuItemProps) {
  return (
    <button role="menuitem" onClick={() => onSelect?.()} {...rest}>
      {icon}
      {children}
      {shortcut ? <span className="ui-menu__shortcut">{shortcut}</span> : null}
    </button>
  );
}

/** Children-only pass-through for roots, triggers and tooltips. */
function PassThrough({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

/** Inline menu surface that keeps its test id. */
function DropdownMenuContent({
  children,
  "data-testid": testId,
}: {
  children?: React.ReactNode;
  "data-testid"?: string;
}) {
  return (
    <div role="menu" data-testid={testId}>
      {children}
    </div>
  );
}

/** The module double; `toast` methods are fresh spies per mock. */
export function terminalViewUiMock() {
  return {
    Tooltip: PassThrough,
    Button,
    DropdownMenuRoot: PassThrough,
    DropdownMenuTrigger: PassThrough,
    DropdownMenuContent,
    MenuItem,
    MenuSeparator: () => <hr />,
    toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
  };
}
