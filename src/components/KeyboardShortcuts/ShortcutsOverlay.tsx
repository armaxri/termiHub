import { useState, useMemo } from "react";
import { Modal, Input } from "@/components/ui";
import { ShortcutCategory, ShortcutScope } from "@/types/keybindings";
import {
  getDefaultBindings,
  getEffectiveCombo,
  serializeBinding,
  isUnboundCombo,
} from "@/services/keybindings";
import { isMac } from "@/utils/platform";
import "./ShortcutsOverlay.css";

/** Human-readable "Active in" hint derived from an action's scope. */
const SCOPE_HINTS: Record<ShortcutScope, string> = {
  global: "All tabs",
  terminal: "Terminal tabs",
  "editor-delegated": "Yields to editors & inputs",
};

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  general: "General",
  clipboard: "Clipboard",
  terminal: "Terminal",
  navigation: "Navigation / Split",
  "tab-groups": "Tab Groups",
};

const CATEGORY_ORDER: ShortcutCategory[] = [
  "general",
  "clipboard",
  "terminal",
  "navigation",
  "tab-groups",
];

interface ShortcutsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutsOverlay({ open, onOpenChange }: ShortcutsOverlayProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const currentPlatformIsMac = isMac();

  const bindings = getDefaultBindings();

  const filteredBindings = useMemo(() => {
    if (!searchQuery.trim()) return bindings;
    const q = searchQuery.toLowerCase();
    return bindings.filter(
      (b) =>
        b.label.toLowerCase().includes(q) ||
        b.action.toLowerCase().includes(q) ||
        b.category.toLowerCase().includes(q)
    );
  }, [bindings, searchQuery]);

  const groupedBindings = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    bindings: filteredBindings.filter((b) => b.category === cat),
  })).filter((g) => g.bindings.length > 0);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard Shortcuts"
      size="lg"
      data-testid="shortcuts-overlay"
    >
      <div className="shortcuts-overlay__search">
        <Input
          placeholder="Search shortcuts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          data-testid="shortcuts-overlay-search"
          autoFocus
        />
      </div>

      <table className="shortcuts-overlay__table">
        <thead>
          <tr>
            <th>Action</th>
            <th className={!currentPlatformIsMac ? "shortcuts-overlay__highlight" : ""}>
              Win / Linux
            </th>
            <th className={currentPlatformIsMac ? "shortcuts-overlay__highlight" : ""}>macOS</th>
          </tr>
        </thead>
        <tbody>
          {groupedBindings.map((group) => (
            <>
              <tr key={`header-${group.category}`} className="shortcuts-overlay__group-row">
                <td colSpan={3} className="shortcuts-overlay__group-label">
                  {group.label}
                </td>
              </tr>
              {group.bindings.map((binding) => {
                const winLinux = binding.winLinuxDefault
                  ? serializeBinding(binding.winLinuxDefault)
                  : "Unbound";
                const mac = binding.macDefault ? serializeBinding(binding.macDefault) : "Unbound";
                const effective = getEffectiveCombo(binding.action);
                const effectiveStr = isUnboundCombo(effective)
                  ? "Unbound"
                  : effective
                    ? serializeBinding(effective)
                    : "";

                return (
                  <tr key={binding.action} data-testid={`shortcut-row-${binding.action}`}>
                    <td className="shortcuts-overlay__action">
                      {binding.label}
                      <span className="shortcuts-overlay__scope">
                        {SCOPE_HINTS[binding.scope ?? "global"]}
                      </span>
                    </td>
                    <td
                      className={`shortcuts-overlay__binding ${!currentPlatformIsMac ? "shortcuts-overlay__highlight" : ""}`}
                    >
                      <kbd>{!currentPlatformIsMac && effective ? effectiveStr : winLinux}</kbd>
                    </td>
                    <td
                      className={`shortcuts-overlay__binding ${currentPlatformIsMac ? "shortcuts-overlay__highlight" : ""}`}
                    >
                      <kbd>{currentPlatformIsMac && effective ? effectiveStr : mac}</kbd>
                    </td>
                  </tr>
                );
              })}
            </>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
