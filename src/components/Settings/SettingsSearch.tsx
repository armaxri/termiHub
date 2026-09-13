import { useCallback } from "react";
import { SearchInput } from "@/components/ui";

interface SettingsSearchProps {
  query: string;
  onQueryChange: (query: string) => void;
}

export function SettingsSearch({ query, onQueryChange }: SettingsSearchProps) {
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
      <SearchInput
        value={query}
        onValueChange={onQueryChange}
        onKeyDown={handleKeyDown}
        placeholder="Search settings..."
        aria-label="Search settings"
        clearLabel="Clear search"
      />
    </div>
  );
}
