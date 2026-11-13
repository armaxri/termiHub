import { useCallback, useState } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import "./SettingsNav.css";

interface CategoryItem {
  id: string;
  label: string;
}

/** A labelled heading over some of the categories (#5561). */
export interface SettingsNavGroup<T extends string = string> {
  id: string;
  label: string;
  categories: T[];
  /** Starts folded; opens on click, or by itself while it holds the active or a matched category. */
  collapsible?: boolean;
}

interface SettingsNavProps<T extends string = string> {
  categories: CategoryItem[];
  iconMap: Record<T, LucideIcon>;
  activeCategory: T;
  onCategoryChange: (category: T) => void;
  highlightedCategories?: Set<T>;
  isCompact: boolean;
  /**
   * Optional headings. Without them (or in compact mode) the nav is one flat
   * tab list, as the connection editor uses it.
   */
  groups?: SettingsNavGroup<T>[];
}

export function SettingsNav<T extends string = string>({
  categories,
  iconMap,
  activeCategory,
  onCategoryChange,
  highlightedCategories,
  isCompact,
  groups,
}: SettingsNavProps<T>) {
  const [openedGroups, setOpenedGroups] = useState<Set<string>>(() => new Set());
  const grouped = !isCompact && groups !== undefined && groups.length > 0;

  /** Whether a collapsible group shows its items right now. */
  const isGroupOpen = useCallback(
    (group: SettingsNavGroup<T>) =>
      !group.collapsible ||
      openedGroups.has(group.id) ||
      group.categories.includes(activeCategory) ||
      (highlightedCategories !== undefined &&
        group.categories.some((id) => highlightedCategories.has(id))),
    [openedGroups, activeCategory, highlightedCategories]
  );

  // Arrow keys move through the categories the user can see, across groups.
  const reachable = grouped
    ? groups.filter(isGroupOpen).flatMap((g) => g.categories as string[])
    : categories.map((c) => c.id);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = reachable.indexOf(activeCategory);
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        onCategoryChange(reachable[(currentIndex + 1) % reachable.length] as T);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        onCategoryChange(reachable[(currentIndex - 1 + reachable.length) % reachable.length] as T);
      }
    },
    [reachable, activeCategory, onCategoryChange]
  );

  const renderItem = (cat: CategoryItem, group?: { id: string; collapsed: boolean }) => {
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
        data-testid={`settings-nav-${cat.id}`}
        // Lets a test harness find and open a folded group before clicking (#5561).
        data-nav-group={group?.id}
        data-group-collapsed={group?.collapsed ? "true" : undefined}
      >
        <Icon size={16} />
        <span className="settings-nav__label">{cat.label}</span>
      </button>
    );
  };

  if (!grouped) {
    return (
      <nav
        className={`settings-nav ${isCompact ? "settings-nav--compact" : ""}`}
        role="tablist"
        aria-label="Settings categories"
        onKeyDown={handleKeyDown}
      >
        {categories.map((cat) => renderItem(cat))}
      </nav>
    );
  }

  const byId = new Map(categories.map((c) => [c.id, c]));
  const toggleGroup = (id: string) =>
    setOpenedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <nav
      className="settings-nav settings-nav--grouped"
      aria-label="Settings categories"
      onKeyDown={handleKeyDown}
    >
      {groups.map((group) => {
        const open = isGroupOpen(group);
        const items = group.categories.flatMap((id) => {
          const cat = byId.get(id);
          return cat ? [cat] : [];
        });
        if (items.length === 0) return null;
        const headingId = `settings-navgroup-${group.id}`;
        // Forced open (active or matched item inside): the toggle cannot fold it.
        const forced = open && !openedGroups.has(group.id);
        return (
          <div key={group.id} className="settings-nav__group">
            {group.collapsible ? (
              <button
                type="button"
                id={headingId}
                className="settings-nav__group-label settings-nav__group-toggle"
                aria-expanded={open}
                aria-disabled={forced || undefined}
                onClick={() => !forced && toggleGroup(group.id)}
                data-testid={`settings-navgroup-${group.id}-toggle`}
              >
                <ChevronRight
                  size={12}
                  aria-hidden="true"
                  className={`settings-nav__group-chevron ${open ? "settings-nav__group-chevron--open" : ""}`}
                />
                {group.label}
              </button>
            ) : (
              <div
                id={headingId}
                className="settings-nav__group-label"
                data-testid={`settings-navgroup-${group.id}`}
              >
                {group.label}
              </div>
            )}
            <div
              role="tablist"
              aria-orientation="vertical"
              aria-labelledby={headingId}
              className="settings-nav__group-items"
              hidden={!open}
            >
              {items.map((cat) => renderItem(cat, { id: group.id, collapsed: !open }))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
