import { useState, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { ShortcutCategory } from "@/types/keybindings";
import { getDefaultBindings, getEffectiveCombo, serializeBinding } from "@/services/keybindings";
import { isMac } from "@/utils/platform";
import "./ShortcutsOverlay.css";

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  general: "General",
  clipboard: "Clipboard",
  terminal: "Terminal",
  navigation: "Navigation / Split",
};

const CATEGORY_ORDER: ShortcutCategory[] = ["general", "clipboard", "terminal", "navigation"];

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="shortcuts-overlay__backdrop" />
        <Dialog.Content
          className="shortcuts-overlay__content"
          data-testid="shortcuts-overlay"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="shortcuts-overlay__header">
            <Dialog.Title className="shortcuts-overlay__title">Keyboard Shortcuts</Dialog.Title>
            <Dialog.Close asChild>
              <button className="shortcuts-overlay__close" data-testid="shortcuts-overlay-close">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="shortcuts-overlay__search">
            <input
              type="text"
              placeholder="Search shortcuts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="shortcuts-overlay__search-input"
              data-testid="shortcuts-overlay-search"
              autoFocus
            />
          </div>

          <div className="shortcuts-overlay__body">
            <table className="shortcuts-overlay__table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th className={!currentPlatformIsMac ? "shortcuts-overlay__highlight" : ""}>
                    Win / Linux
                  </th>
                  <th className={currentPlatformIsMac ? "shortcuts-overlay__highlight" : ""}>
                    macOS
                  </th>
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
                      const winLinux = serializeBinding(binding.winLinuxDefault);
                      const mac = serializeBinding(binding.macDefault);
                      const effective = getEffectiveCombo(binding.action);
                      const effectiveStr = effective ? serializeBinding(effective) : "";

                      return (
                        <tr key={binding.action} data-testid={`shortcut-row-${binding.action}`}>
                          <td className="shortcuts-overlay__action">{binding.label}</td>
                          <td
                            className={`shortcuts-overlay__binding ${!currentPlatformIsMac ? "shortcuts-overlay__highlight" : ""}`}
                          >
                            <kbd>
                              {!currentPlatformIsMac && effective ? effectiveStr : winLinux}
                            </kbd>
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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
