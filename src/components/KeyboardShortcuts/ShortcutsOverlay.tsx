import { Fragment } from "react";
import { Pencil } from "lucide-react";
import { Modal, Button, SearchInput } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useListFilter, type ListFilterFields } from "@/hooks/useListFilter";
import { ShortcutCategory, ShortcutScope, KeyBinding } from "@/types/keybindings";
import { getDefaultBindings, formatActionBindings } from "@/services/keybindings";
import "./ShortcutsOverlay.css";

/**
 * Searchable text of a keybinding: its label, action id, and category.
 * Module-level so the {@link useListFilter} memo stays stable across renders.
 */
const shortcutFields: ListFilterFields<KeyBinding> = (binding) => [
  binding.label,
  binding.action,
  binding.category,
];

/** Human-readable "Active in" hint derived from an action's scope. */
const SCOPE_HINTS: Record<ShortcutScope, string> = {
  global: "All tabs",
  terminal: "Terminal tabs",
  "editor-delegated": "Yields to editors & inputs",
  "yields-to-terminal": "Outside terminals",
  "remote-desktop": "Focused remote desktop",
};

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  general: "General",
  clipboard: "Clipboard",
  terminal: "Terminal",
  navigation: "Navigation / Split",
  "tab-groups": "Tab Groups",
  "remote-desktop": "Remote Desktop",
};

const CATEGORY_ORDER: ShortcutCategory[] = [
  "general",
  "clipboard",
  "terminal",
  "navigation",
  "tab-groups",
  "remote-desktop",
];

interface ShortcutsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Display text for an action's binding on the running platform: the user
 * override when one exists, else the platform default (#4711). Formatting goes
 * through the display formatter (`formatComboForDisplay`), never the
 * persistence serializer.
 */
function currentPlatformBindingText(action: string): string {
  // Lists alternate defaults too, e.g. "Cmd+P / Cmd+Shift+P" (#5084).
  return formatActionBindings(action) ?? "Unbound";
}

/**
 * Read-only keyboard shortcuts overlay. The platform is known locally, so it
 * shows a single "Shortcut" column with the running platform's bindings
 * (#4711); the exported cheat sheet can still list every platform.
 */
export function ShortcutsOverlay({ open, onOpenChange }: ShortcutsOverlayProps) {
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);

  const bindings = getDefaultBindings();
  const { query, setQuery, filtered: filteredBindings } = useListFilter(bindings, shortcutFields);

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
            <th>Shortcut</th>
          </tr>
        </thead>
        <tbody>
          {groupedBindings.map((group) => (
            <Fragment key={group.category}>
              <tr className="shortcuts-overlay__group-row">
                <td colSpan={2} className="shortcuts-overlay__group-label">
                  {group.label}
                </td>
              </tr>
              {group.bindings.map((binding) => (
                <tr key={binding.action} data-testid={`shortcut-row-${binding.action}`}>
                  <td className="shortcuts-overlay__action">
                    {binding.label}
                    <span className="shortcuts-overlay__scope">
                      {SCOPE_HINTS[binding.scope ?? "global"]}
                    </span>
                  </td>
                  <td className="shortcuts-overlay__binding">
                    <kbd>{currentPlatformBindingText(binding.action)}</kbd>
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
