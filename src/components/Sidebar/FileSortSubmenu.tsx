import { ArrowDownUp, Check } from "lucide-react";
import {
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "@/components/ui";
import type { FileSortKey, SortDirection } from "@/utils/fileBrowserNav";

/** The file list's sort: column and direction. */
export interface FileSort {
  key: FileSortKey;
  dir: SortDirection;
}

/** Display name of each sort column. */
export const SORT_KEY_LABELS: Record<FileSortKey, string> = {
  name: "Name",
  modified: "Modified",
  size: "Size",
};

const SORT_KEYS: FileSortKey[] = ["name", "modified", "size"];
const DIRECTIONS: { dir: SortDirection; label: string }[] = [
  { dir: "asc", label: "Ascending" },
  { dir: "desc", label: "Descending" },
];

/** Props for {@link FileSortSubmenu}. */
export interface FileSortSubmenuProps {
  sort: FileSort;
  onSort: (sort: FileSort) => void;
}

/** One checkable row; the tick slot keeps its room when unchecked so labels align. */
function SortRadio({ value, testId, label }: { value: string; testId: string; label: string }) {
  return (
    <MenuRadioItem value={value} data-testid={testId}>
      <span className="file-sort-menu__tick">
        <MenuItemIndicator>
          <Check size={14} />
        </MenuItemIndicator>
      </span>
      {label}
    </MenuRadioItem>
  );
}

/**
 * "Sort by ▸" in the file browser's "…" menu (#5671). The Modified / Size
 * column headers hide at narrow sidebar widths, and they were the only sort
 * controls; this sub-menu offers every column and both directions at any width,
 * with the active choice ticked. Picking a new column starts ascending.
 */
export function FileSortSubmenu({ sort, onSort }: FileSortSubmenuProps) {
  return (
    <MenuSub>
      <MenuSubTrigger icon={<ArrowDownUp size={14} />} data-testid="file-browser-sort-menu">
        Sort by
      </MenuSubTrigger>
      <MenuSubContent sideOffset={4} data-testid="file-browser-sort-submenu">
        <MenuRadioGroup
          value={sort.key}
          onValueChange={(key) =>
            onSort({ key: key as FileSortKey, dir: key === sort.key ? sort.dir : "asc" })
          }
        >
          {SORT_KEYS.map((key) => (
            <SortRadio
              key={key}
              value={key}
              testId={`file-browser-sort-by-${key}`}
              label={SORT_KEY_LABELS[key]}
            />
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuRadioGroup
          value={sort.dir}
          onValueChange={(dir) => onSort({ key: sort.key, dir: dir as SortDirection })}
        >
          {DIRECTIONS.map(({ dir, label }) => (
            <SortRadio
              key={dir}
              value={dir}
              testId={`file-browser-sort-dir-${dir}`}
              label={label}
            />
          ))}
        </MenuRadioGroup>
      </MenuSubContent>
    </MenuSub>
  );
}
