import { useCallback } from "react";
import { Settings2, Palette, TerminalSquare, FileJson } from "lucide-react";
import { SettingsCategory, CATEGORIES } from "./settingsRegistry";
import "./SettingsNav.css";

const CATEGORY_ICONS: Record<SettingsCategory, React.ComponentType<{ size?: number }>> = {
  general: Settings2,
  appearance: Palette,
  terminal: TerminalSquare,
  "external-files": FileJson,
};

interface SettingsNavProps {
  activeCategory: SettingsCategory;
  onCategoryChange: (category: SettingsCategory) => void;
  highlightedCategories?: Set<SettingsCategory>;
  isCompact: boolean;
}

export function SettingsNav({
  activeCategory,
  onCategoryChange,
  highlightedCategories,
  isCompact,
}: SettingsNavProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = CATEGORIES.findIndex((c) => c.id === activeCategory);
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        const next = (currentIndex + 1) % CATEGORIES.length;
        onCategoryChange(CATEGORIES[next].id);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        const prev = (currentIndex - 1 + CATEGORIES.length) % CATEGORIES.length;
        onCategoryChange(CATEGORIES[prev].id);
      }
    },
    [activeCategory, onCategoryChange]
  );

  return (
    <nav
      className={`settings-nav ${isCompact ? "settings-nav--compact" : ""}`}
      role="tablist"
      aria-label="Settings categories"
      onKeyDown={handleKeyDown}
    >
      {CATEGORIES.map((cat) => {
        const Icon = CATEGORY_ICONS[cat.id];
        const isActive = cat.id === activeCategory;
        const isHighlighted = highlightedCategories ? highlightedCategories.has(cat.id) : true;
        return (
          <button
            key={cat.id}
            role="tab"
            aria-selected={isActive}
            className={`settings-nav__item ${isActive ? "settings-nav__item--active" : ""} ${!isHighlighted ? "settings-nav__item--dimmed" : ""}`}
            onClick={() => onCategoryChange(cat.id)}
            tabIndex={isActive ? 0 : -1}
          >
            <Icon size={16} />
            <span className="settings-nav__label">{cat.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
