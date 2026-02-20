import { useCallback, useRef } from "react";
import { Search, X } from "lucide-react";

interface SettingsSearchProps {
  query: string;
  onQueryChange: (query: string) => void;
}

export function SettingsSearch({ query, onQueryChange }: SettingsSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClear = useCallback(() => {
    onQueryChange("");
    inputRef.current?.focus();
  }, [onQueryChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onQueryChange("");
      }
    },
    [onQueryChange]
  );

  return (
    <div className="settings-search">
      <Search size={14} className="settings-search__icon" />
      <input
        ref={inputRef}
        className="settings-search__input"
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search settings..."
      />
      {query && (
        <button
          className="settings-search__clear"
          onClick={handleClear}
          title="Clear search"
          type="button"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
