import { Pencil } from "lucide-react";
import { Modal, Button, SearchInput } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useListFilter, type ListFilterMatcher } from "@/hooks/useListFilter";
import { ShortcutCategory, ShortcutScope, KeyBinding } from "@/types/keybindings";
import {
  getDefaultBindings,
  getEffectiveCombo,
  serializeBinding,
  isUnboundCombo,
} from "@/services/keybindings";
import { isMac } from "@/utils/platform";
import "./ShortcutsOverlay.css";

/**
 * Case-insensitive match of a keybinding against the (already normalized) query
 * on its label, action id, or category. Module-level so the {@link useListFilter}
 * memo stays stable across renders.
 */
const shortcutMatches: ListFilterMatcher<KeyBinding> = (binding, query) => {
  if (!query) return true;
  return (
    binding.label.toLowerCase().includes(query) ||
    binding.action.toLowerCase().includes(query) ||
    binding.category.toLowerCase().includes(query)
  );
};

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
  const currentPlatformIsMac = isMac();
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);

  const bindings = getDefaultBindings();
  const { query, setQuery, filtered: filteredBindings } = useListFilter(bindings, shortcutMatches);

  /**
   * Close the read-only overlay and deep-link to Settings → Keyboard, where the
   * shortcuts can actually be rebound. This is the single discoverable bridge
   * from the shortcuts cheat sheet to the editor (UX-031).
   */
  const handleEditShortcuts = () => {
    onOpenChange(false);
    openSettingsTab({ category: "keyboard" });
  };

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
      footer={
        <Button
          variant="secondary"
          size="sm"
          icon={<Pencil size={14} />}
          onClick={handleEditShortcuts}
          data-testid="shortcuts-overlay-edit"
        >
          Edit shortcuts…
        </Button>
      }
    >
      <div className="shortcuts-overlay__search">
        <SearchInput
          placeholder="Search shortcuts..."
          value={query}
          onValueChange={setQuery}
          data-testid="shortcuts-overlay-search"
          clearLabel="Clear shortcut search"
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
