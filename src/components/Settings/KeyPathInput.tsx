import { useState, useRef, useCallback, useEffect, useId, useMemo } from "react";
import { open } from "@/services/nativeDialog";
import { useSshKeyFiles, SshKeyFile } from "@/hooks/useSshKeyFiles";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { validateSshKey, SshKeyValidation } from "@/services/api";
import { Input, Tooltip } from "@/components/ui";
import "./KeyPathInput.css";
import { itemMatchesQuery } from "@/hooks/useListFilter";
import { useComboboxListNav } from "@/hooks/useComboboxListNav";

/** Debounce (ms) before validating a typed key path against the backend. */
const VALIDATION_DEBOUNCE_MS = 300;

interface KeyPathInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testIdPrefix?: string;
  /** `id` of the combobox input, so an external `<label htmlFor>` can point at it. */
  id?: string;
  /** Space-separated ids of elements describing the input (e.g. an error message). */
  "aria-describedby"?: string;
  /** Marks the input invalid for assistive tech when validation fails. */
  "aria-invalid"?: boolean;
}

/** Combobox input for selecting SSH key files from ~/.ssh/ with type-ahead filtering. */
export function KeyPathInput({
  value,
  onChange,
  placeholder,
  testIdPrefix,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: KeyPathInputProps) {
  const { keyFiles, sshDirPath } = useSshKeyFiles();
  const [isOpen, setIsOpen] = useState(false);
  const [validation, setValidation] = useState<SshKeyValidation | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Stable ids for the WAI-ARIA combobox wiring (#4330): the input controls the
  // listbox, points aria-activedescendant at the highlighted option, and is
  // described by the validation live region.
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const validationId = `${baseId}-validation`;

  // Inline key-file validation (PR #204): debounce a backend check of the typed
  // path and surface a hint (public key / PuTTY PPK / unrecognized / not found /
  // valid OpenSSH-or-PEM key) before a connection is attempted. The keyPath
  // field is only shown for key auth, so validating whenever it has a value is
  // appropriate. An empty path is "no key selected yet" — no call, no hint.
  const debouncedValidate = useDebouncedCallback((path: string) => {
    validateSshKey(path)
      .then(setValidation)
      .catch(() => setValidation(null));
  }, VALIDATION_DEBOUNCE_MS);
  useEffect(() => {
    if (value.trim() === "") {
      // Empty path clears the hint immediately and drops any pending check.
      debouncedValidate.cancel();
      setValidation(null);
      return;
    }
    debouncedValidate(value);
    return () => debouncedValidate.cancel();
  }, [value, debouncedValidate]);

  const filtered = useMemo(() => {
    const q = value.trim();
    if (!q) return keyFiles;
    return keyFiles.filter((f) => itemMatchesQuery(f, (k) => [k.name, k.path], q));
  }, [keyFiles, value]);

  const listVisible = isOpen && filtered.length > 0;

  const acceptItem = (item: SshKeyFile) => {
    onChange(item.path);
    setIsOpen(false);
    // `nav` is initialised below; this only runs from its event handlers.
    nav.setActiveIndex(-1);
  };

  const closeList = useCallback(() => setIsOpen(false), []);

  // Shared combobox keyboard navigation (#4646): nothing is highlighted until the
  // arrow keys move into the list, and the highlight resets whenever the
  // filtered list changes. Tab accepts the highlighted option (or the only one).
  const nav = useComboboxListNav({
    items: filtered,
    onSelect: acceptItem,
    resetKey: filtered,
    listId,
    autocomplete: true,
    open: listVisible,
    onClose: closeList,
    onUnhandledKeyDown: (e) => {
      if (!listVisible || e.key !== "Tab") return;
      const target = nav.activeItem ?? (filtered.length === 1 ? filtered[0] : undefined);
      if (target !== undefined) {
        e.preventDefault();
        acceptItem(target);
      }
    },
  });
  const { setActiveIndex } = nav;

  const handleFocus = useCallback(() => {
    if (keyFiles.length > 0) {
      setIsOpen(true);
    }
  }, [keyFiles]);

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      // Don't close if focus moves within the wrapper (e.g. clicking a dropdown item)
      if (wrapperRef.current?.contains(e.relatedTarget as Node)) return;
      setIsOpen(false);
      setActiveIndex(-1);
    },
    [setActiveIndex]
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
  const validationMessage = validation?.message ? validation.message : null;
  const describedBy =
    [ariaDescribedBy, validationMessage ? validationId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <>
      <div className="key-path-input" ref={wrapperRef} onBlur={handleBlur}>
        <Input
          ref={inputRef}
          id={id}
          className="key-path-input__field"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (!isOpen && keyFiles.length > 0) setIsOpen(true);
          }}
          onFocus={handleFocus}
          placeholder={placeholder}
          {...nav.inputProps}
          aria-expanded={listVisible}
          aria-describedby={describedBy}
          aria-invalid={ariaInvalid || undefined}
          data-testid={`${prefix}key-path-input`}
        />
        <Tooltip content="Browse">
          <button
            type="button"
            className="settings-form__list-browse"
            onClick={handleBrowse}
            aria-label="Browse"
            data-testid={`${prefix}key-path-browse`}
          >
            ...
          </button>
        </Tooltip>
        {listVisible && (
          <ul
            {...nav.listboxProps}
            className="key-path-input__dropdown"
            data-testid={`${prefix}key-path-dropdown`}
          >
            {filtered.map((file, i) => {
              // Picking happens on mousedown (before the input blurs), so the
              // hook's click / mousemove handlers are not used here.
              const {
                onClick: _onClick,
                onMouseMove: _onMouseMove,
                ...optionProps
              } = nav.getOptionProps(i);
              return (
                <li
                  key={file.path}
                  {...optionProps}
                  className={`key-path-input__option${i === nav.activeIndex ? " key-path-input__option--highlighted" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault(); // Prevent blur before click registers
                    acceptItem(file);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  data-testid={`${prefix}key-path-option-${i}`}
                >
                  {file.name}
                  <span className="key-path-input__option-path">{file.path}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {validation && validationMessage && (
        <p
          id={validationId}
          className={`settings-form__hint settings-form__hint--${validation.status}`}
          data-testid={`${prefix}key-path-validation`}
        >
          {validationMessage}
        </p>
      )}
      {/* Always-mounted, visually hidden polite live region so a newly arriving
          validation result (key not found / unreadable / valid) is announced
          (#4330). Kept out of layout so it adds no gap to the field. */}
      <span className="sr-only" role="status" aria-live="polite">
        {validationMessage ?? ""}
      </span>
    </>
  );
}
