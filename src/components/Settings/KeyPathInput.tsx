import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSshKeyFiles, SshKeyFile } from "@/hooks/useSshKeyFiles";
import "./KeyPathInput.css";

interface KeyPathInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testIdPrefix?: string;
}

/** Combobox input for selecting SSH key files from ~/.ssh/ with type-ahead filtering. */
export function KeyPathInput({ value, onChange, placeholder, testIdPrefix }: KeyPathInputProps) {
  const { keyFiles, sshDirPath } = useSshKeyFiles();
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    if (!value) return keyFiles;
    const lower = value.toLowerCase();
    return keyFiles.filter(
      (f) => f.name.toLowerCase().includes(lower) || f.path.toLowerCase().includes(lower)
    );
  }, [keyFiles, value]);

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightIndex(-1);
  }, [filtered]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      const items = listRef.current.children;
      if (items[highlightIndex]) {
        (items[highlightIndex] as HTMLElement).scrollIntoView({ block: "nearest" });
      }
    }
  }, [highlightIndex]);

  const acceptItem = useCallback(
    (item: SshKeyFile) => {
      onChange(item.path);
      setIsOpen(false);
      setHighlightIndex(-1);
    },
    [onChange]
  );

  const handleFocus = useCallback(() => {
    if (keyFiles.length > 0) {
      setIsOpen(true);
    }
  }, [keyFiles]);

  const handleBlur = useCallback((e: React.FocusEvent) => {
    // Don't close if focus moves within the wrapper (e.g. clicking a dropdown item)
    if (wrapperRef.current?.contains(e.relatedTarget as Node)) return;
    setIsOpen(false);
    setHighlightIndex(-1);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen || filtered.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
          break;
        case "Tab":
          if (highlightIndex >= 0) {
            e.preventDefault();
            acceptItem(filtered[highlightIndex]);
          } else if (filtered.length === 1) {
            e.preventDefault();
            acceptItem(filtered[0]);
          }
          break;
        case "Enter":
          if (highlightIndex >= 0) {
            e.preventDefault();
            acceptItem(filtered[highlightIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          setHighlightIndex(-1);
          break;
      }
    },
    [isOpen, filtered, highlightIndex, acceptItem]
  );

  const handleBrowse = useCallback(async () => {
    const selected = await open({
      multiple: false,
      title: "Select SSH private key",
      defaultPath: sshDirPath || undefined,
    });
    if (selected) {
      onChange(selected as string);
    }
  }, [sshDirPath, onChange]);

  const prefix = testIdPrefix ? `${testIdPrefix}-` : "";

  return (
    <div className="key-path-input" ref={wrapperRef} onBlur={handleBlur}>
      <input
        ref={inputRef}
        type="text"
        className="key-path-input__field"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (!isOpen && keyFiles.length > 0) setIsOpen(true);
        }}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={isOpen}
        aria-autocomplete="list"
        data-testid={`${prefix}key-path-input`}
      />
      <button
        type="button"
        className="settings-form__list-browse"
        onClick={handleBrowse}
        title="Browse"
        data-testid={`${prefix}key-path-browse`}
      >
        ...
      </button>
      {isOpen && filtered.length > 0 && (
        <ul
          className="key-path-input__dropdown"
          ref={listRef}
          role="listbox"
          data-testid={`${prefix}key-path-dropdown`}
        >
          {filtered.map((file, i) => (
            <li
              key={file.path}
              className={`key-path-input__option${i === highlightIndex ? " key-path-input__option--highlighted" : ""}`}
              role="option"
              aria-selected={i === highlightIndex}
              onMouseDown={(e) => {
                e.preventDefault(); // Prevent blur before click registers
                acceptItem(file);
              }}
              onMouseEnter={() => setHighlightIndex(i)}
              data-testid={`${prefix}key-path-option-${i}`}
            >
              {file.name}
              <span className="key-path-input__option-path">{file.path}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
