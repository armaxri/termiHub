import { Copy } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";

/** Combined view of a built-in mapping row (shown in the reference table). */
export interface BuiltInRow {
  pattern: string;
  language: string;
  kind: "filename" | "extension";
}

export interface FileTypeBuiltInTableProps {
  rows: readonly BuiltInRow[];
  userMappings: Record<string, string>;
  onCopy: (pattern: string, language: string) => void;
}

/** Dense pattern → language table (#5713): one aligned row per built-in mapping. */
export function FileTypeBuiltInTable({ rows, userMappings, onCopy }: FileTypeBuiltInTableProps) {
  return (
    <table className="file-type-settings__table" data-testid="file-type-builtin-table">
      <thead>
        <tr>
          <th scope="col">Pattern</th>
          <th scope="col">Language</th>
          <th scope="col" className="file-type-settings__action-col">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ pattern, language }) => {
          const isOverridden = pattern in userMappings;
          return (
            <tr
              key={pattern}
              className="file-type-settings__row"
              data-overridden={isOverridden ? "true" : undefined}
              data-testid={`file-type-builtin-row-${pattern}`}
            >
              <td className="file-type-settings__pattern">
                <span data-testid={`file-type-builtin-pattern-${pattern}`}>{pattern}</span>
                {isOverridden && (
                  <span
                    className="settings-panel__badge file-type-settings__badge"
                    data-testid={`file-type-overridden-badge-${pattern}`}
                  >
                    overridden
                  </span>
                )}
              </td>
              <td
                className="file-type-settings__language"
                data-testid={`file-type-builtin-language-${pattern}`}
              >
                {language}
              </td>
              <td className="file-type-settings__action">
                <Tooltip content={`Copy "${pattern}" into the add form`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<Copy size={14} />}
                    onClick={() => onCopy(pattern, language)}
                    aria-label={`Copy "${pattern}" into the add form`}
                    data-testid={`file-type-copy-${pattern}`}
                  />
                </Tooltip>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
