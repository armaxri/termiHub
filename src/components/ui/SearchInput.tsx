import { forwardRef } from "react";
import { Search, X } from "lucide-react";
import { Input, type InputProps } from "./Input";
import "./ui.css";

/**
 * Props for the shared {@link SearchInput} primitive. Extends {@link InputProps}
 * (minus the props this primitive owns: `type`, `value`, and `onChange`) so any
 * standard input attribute (`placeholder`, `aria-label`, `data-testid`, `size`,
 * …) is forwarded to the underlying {@link Input}.
 */
export interface SearchInputProps extends Omit<
  InputProps,
  "type" | "value" | "onChange" | "inline"
> {
  /** Current query text (controlled). */
  value: string;
  /**
   * Called with the new query string on every keystroke and when the clear
   * button is pressed. A thin wrapper over the native input's `onChange` that
   * hands back `event.target.value` directly, matching the `setQuery` shape the
   * search sites already use.
   */
  onValueChange: (value: string) => void;
  /**
   * Accessible label for the clear button. Defaults to `"Clear search"`. The
   * clear button only renders when `value` is non-empty.
   */
  clearLabel?: string;
}

/**
 * The shared search-input primitive: a token-styled skin over {@link Input} with
 * a leading lucide search icon and a trailing clear button that appears while
 * the field is non-empty. Consolidates the wrapper + absolutely-positioned
 * `Search` icon + left-padded `Input` pattern that the sidebars and pickers each
 * hand-rolled (UISF-004).
 *
 * It renders a native `type="search"` field (implicit `role="searchbox"`); the
 * browser's built-in clear affordance is suppressed via CSS in favour of the
 * token-styled clear button. Compose it wherever a list needs a filter box —
 * pair it with the `useListFilter` hook for the query state + filtered list.
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onValueChange, clearLabel = "Clear search", className, ...rest },
  ref
) {
  const wrapperClasses = [
    "ui-search-input",
    value ? "ui-search-input--clearable" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wrapperClasses}>
      <Search size={14} className="ui-search-input__icon" aria-hidden="true" />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          className="ui-search-input__clear"
          aria-label={clearLabel}
          onClick={() => onValueChange("")}
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
});
