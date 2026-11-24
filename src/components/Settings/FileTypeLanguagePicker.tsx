import { forwardRef, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  EmptyState,
  MenuItem,
  SearchInput,
} from "@/components/ui";
import { itemMatchesQuery } from "@/hooks/useListFilter";
import type { LanguageInfo } from "@/types/terminal";

/** Keys the search box hands on to the menu so they move into the list. */
const MENU_NAV_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "Escape", "Tab"]);

function languageFields(l: LanguageInfo): ReadonlyArray<string> {
  return [l.name, l.id];
}

/**
 * Languages whose name or id matches `search` (case- and diacritic-insensitive
 * substring, through the shared {@link itemMatchesQuery}). Empty keeps all.
 */
export function filterLanguageOptions(
  languages: readonly LanguageInfo[],
  search: string
): LanguageInfo[] {
  const q = search.trim();
  if (!q) return [...languages];
  return languages.filter((l) => itemMatchesQuery(l, languageFields, q));
}

export interface FileTypeLanguagePickerProps {
  /** Selected language id, or `""` for none. */
  value: string;
  /** The languages to offer, in display order. */
  languages: readonly LanguageInfo[];
  /** Called with the picked language id. */
  onChange: (languageId: string) => void;
  /** Marks the trigger invalid for assistive tech. */
  "aria-invalid"?: boolean;
  /** Space-separated ids describing the trigger (e.g. the add error). */
  "aria-describedby"?: string;
}

/**
 * Searchable language list for a file type mapping (#5841). A typo can no
 * longer produce an unknown language: the value always comes from the list.
 * Built on the same dropdown + search pattern as the status bar's language
 * selector.
 */
export const FileTypeLanguagePicker = forwardRef<HTMLButtonElement, FileTypeLanguagePickerProps>(
  function FileTypeLanguagePicker(
    {
      value,
      languages,
      onChange,
      "aria-invalid": ariaInvalid,
      "aria-describedby": ariaDescribedBy,
    },
    ref
  ) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const filtered = useMemo(() => filterLanguageOptions(languages, search), [languages, search]);
    const selected = languages.find((l) => l.id === value);
    const label = selected?.name ?? (value || "Language");

    const pick = (id: string) => {
      onChange(id);
      setOpen(false);
      setSearch("");
    };

    return (
      <DropdownMenuRoot
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch("");
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={ref}
            type="button"
            className="ui-select__trigger settings-panel__create-input file-type-settings__language-trigger"
            aria-label={selected ? `Language: ${selected.name}` : "Language"}
            aria-invalid={ariaInvalid || undefined}
            aria-describedby={ariaDescribedBy}
            data-placeholder={value ? undefined : ""}
            data-value={value}
            data-testid="file-type-language-select"
          >
            <span className="file-type-settings__language-label">{label}</span>
            <span className="ui-select__icon" aria-hidden="true">
              <ChevronDown width={14} height={14} />
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          width="wide"
          align="start"
          sideOffset={4}
          className="file-type-settings__language-menu"
          data-testid="file-type-language-menu"
        >
          <div className="file-type-settings__language-search">
            <SearchInput
              size="sm"
              placeholder="Search languages…"
              aria-label="Search languages"
              value={search}
              onValueChange={setSearch}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (filtered.length > 0) pick(filtered[0].id);
                  return;
                }
                // Keep typed letters out of the menu's typeahead; let the
                // arrow keys move into the list and Escape close it.
                if (!MENU_NAV_KEYS.has(e.key)) e.stopPropagation();
              }}
              autoFocus
              data-testid="file-type-language-search"
              clearLabel="Clear language search"
            />
          </div>
          <div className="file-type-settings__language-list">
            {filtered.map((lang) => (
              <MenuItem
                key={lang.id}
                onSelect={() => pick(lang.id)}
                data-selected={lang.id === value ? "true" : undefined}
                data-testid={`file-type-language-option-${lang.id}`}
              >
                {lang.name}
                {lang.id !== lang.name.toLowerCase() && (
                  <span className="file-type-settings__language-id">{lang.id}</span>
                )}
              </MenuItem>
            ))}
            {filtered.length === 0 && (
              <EmptyState title="No matching languages" data-testid="file-type-language-no-match" />
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenuRoot>
    );
  }
);
