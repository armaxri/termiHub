import { useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import "./SettingsNav.css";

interface CategoryItem {
  id: string;
  label: string;
}

interface SettingsNavProps<T extends string = string> {
  categories: CategoryItem[];
  iconMap: Record<T, LucideIcon>;
  activeCategory: T;
  onCategoryChange: (category: T) => void;
  highlightedCategories?: Set<T>;
  isCompact: boolean;
}

export function SettingsNav<T extends string = string>({
  categories,
  iconMap,
  activeCategory,
  onCategoryChange,
  highlightedCategories,
  isCompact,
}: SettingsNavProps<T>) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = categories.findIndex((c) => c.id === activeCategory);
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        const next = (currentIndex + 1) % categories.length;
        onCategoryChange(categories[next].id as T);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        const prev = (currentIndex - 1 + categories.length) % categories.length;
        onCategoryChange(categories[prev].id as T);
      }
    },
    [categories, activeCategory, onCategoryChange]
  );

  return (
    <nav
      className={`settings-nav ${isCompact ? "settings-nav--compact" : ""}`}
      role="tablist"
      aria-label="Settings categories"
      onKeyDown={handleKeyDown}
    >
      {categories.map((cat) => {
        const Icon: LucideIcon = iconMap[cat.id as T];
        const isActive = cat.id === activeCategory;
        const isHighlighted = highlightedCategories ? highlightedCategories.has(cat.id as T) : true;
        return (
          <button
            key={cat.id}
            role="tab"
            aria-selected={isActive}
            className={`settings-nav__item ${isActive ? "settings-nav__item--active" : ""} ${!isHighlighted ? "settings-nav__item--dimmed" : ""}`}
            onClick={() => onCategoryChange(cat.id as T)}
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
