import { useState, useMemo } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useAppStore } from "@/store/appStore";
import "./StatusBar.css";

const INDENT_SIZES = [1, 2, 4, 8] as const;

/**
 * Status bar displayed at the bottom of the application window.
 * Shows editor status (cursor position, language, EOL, tab size, encoding)
 * when an editor tab is active.
 */
export function StatusBar() {
  const editorStatus = useAppStore((s) => s.editorStatus);
  const editorActions = useAppStore((s) => s.editorActions);

  const indentLabel = editorStatus
    ? editorStatus.insertSpaces
      ? `Spaces: ${editorStatus.tabSize}`
      : `Tab Size: ${editorStatus.tabSize}`
    : "";

  return (
    <div className="status-bar">
      <div className="status-bar__section status-bar__section--left" />
      <div className="status-bar__section status-bar__section--center" />
      <div className="status-bar__section status-bar__section--right">
        {editorStatus && (
          <>
            <span className="status-bar__item">
              Ln {editorStatus.line}, Col {editorStatus.column}
            </span>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="status-bar__item status-bar__item--interactive"
                  title="Select indentation"
                  data-testid="status-bar-tab-size"
                >
                  {indentLabel}
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="indent-menu__content"
                  side="top"
                  align="start"
                  sideOffset={4}
                >
                  <DropdownMenu.Label className="indent-menu__label">
                    Indent Using Spaces
                  </DropdownMenu.Label>
                  {INDENT_SIZES.map((size) => (
                    <DropdownMenu.Item
                      key={`spaces-${size}`}
                      className="indent-menu__item"
                      onSelect={() => editorActions?.setIndent(size, true)}
                      data-testid={`indent-spaces-${size}`}
                    >
                      {size} {size === 1 ? "Space" : "Spaces"}
                    </DropdownMenu.Item>
                  ))}
                  <DropdownMenu.Separator className="indent-menu__separator" />
                  <DropdownMenu.Label className="indent-menu__label">
                    Indent Using Tabs
                  </DropdownMenu.Label>
                  {INDENT_SIZES.map((size) => (
                    <DropdownMenu.Item
                      key={`tabs-${size}`}
                      className="indent-menu__item"
                      onSelect={() => editorActions?.setIndent(size, false)}
                      data-testid={`indent-tabs-${size}`}
                    >
                      Tab Size: {size}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <span className="status-bar__item">{editorStatus.encoding}</span>
            <button
              className="status-bar__item status-bar__item--interactive"
              onClick={() => editorActions?.toggleEol()}
              title="Toggle line endings"
              data-testid="status-bar-eol"
            >
              {editorStatus.eol}
            </button>
            <LanguageSelector
              currentLanguage={editorStatus.language}
              languages={editorStatus.availableLanguages}
              onSelect={(id) => editorActions?.setLanguage(id)}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Language selector dropdown with search filtering.
 */
function LanguageSelector({
  currentLanguage,
  languages,
  onSelect,
}: {
  currentLanguage: string;
  languages: { id: string; name: string }[];
  onSelect: (languageId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const displayName = languages.find((l) => l.id === currentLanguage)?.name ?? currentLanguage;

  const filtered = useMemo(() => {
    if (!search) return languages;
    const lower = search.toLowerCase();
    return languages.filter(
      (l) => l.name.toLowerCase().includes(lower) || l.id.toLowerCase().includes(lower)
    );
  }, [languages, search]);

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) setSearch("");
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          className="status-bar__item status-bar__item--interactive"
          title="Select language mode"
          data-testid="status-bar-language"
        >
          {displayName}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="lang-menu__content"
          side="top"
          align="end"
          sideOffset={4}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="lang-menu__search-wrapper">
            <input
              className="lang-menu__search"
              placeholder="Search languages..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              autoFocus
              data-testid="lang-menu-search"
            />
          </div>
          <div className="lang-menu__list">
            {filtered.map((lang) => (
              <DropdownMenu.Item
                key={lang.id}
                className="lang-menu__item"
                onSelect={() => onSelect(lang.id)}
                data-testid={`lang-${lang.id}`}
              >
                {lang.name}
                {lang.id !== lang.name.toLowerCase() && (
                  <span className="lang-menu__item-id">{lang.id}</span>
                )}
              </DropdownMenu.Item>
            ))}
            {filtered.length === 0 && <div className="lang-menu__empty">No matching languages</div>}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
