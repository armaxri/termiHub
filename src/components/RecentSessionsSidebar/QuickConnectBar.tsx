import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Zap } from "lucide-react";
import { Button, Input, Tooltip, toast } from "@/components/ui";
import type { ConnectionConfig } from "@/types/terminal";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import { parseQuickConnect, quickConnectConfig } from "@/utils/quickConnect";
import { sessionHistoryTitle } from "@/utils/sessionHistoryTitle";
import { formatRelativeTime } from "@/utils/formatters";
import { itemMatchesQuery } from "@/hooks/useListFilter";
import { useComboboxListNav } from "@/hooks/useComboboxListNav";

/** Maximum autocomplete suggestions shown below the quick-connect input. */
const MAX_SUGGESTIONS = 6;

/** Searchable text of a suggestion: the session title and its `user@host` key. */
function suggestionFields(entry: SessionHistoryEntry): string[] {
  return [entry.title, entry.dedupKey];
}

interface QuickConnectBarProps {
  /** History used to drive the autocomplete dropdown. */
  history: SessionHistoryEntry[];
  /** Default SSH user applied when the input omits `user@`. */
  defaultUser?: string;
  /** Open a connection for the given config/title (quick-connect or a suggestion). */
  onConnect: (config: ConnectionConfig, title: string) => void;
}

/**
 * A compact `user@host[:port]` entry bar for fast SSH re-connection, with an
 * autocomplete dropdown drawn from the session history. Pressing Enter (or the
 * connect button) parses the input and opens an SSH tab; a suggestion click
 * re-opens that exact history entry.
 */
export function QuickConnectBar({ history, defaultUser, onConnect }: QuickConnectBarProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const listId = `${useId()}-suggestions`;
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks the pending blur timer so it can be cancelled on re-blur or unmount.
  const blurTimerRef = useRef<number | null>(null);

  // Cancel any pending blur timer on unmount so it never fires setState after
  // the component is gone (which reds test teardown — see #3109).
  useEffect(
    () => () => {
      if (blurTimerRef.current !== null) {
        window.clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
    },
    []
  );

  const suggestions = useMemo(() => {
    const q = value.trim();
    if (!q) return [];
    return history
      .filter((e) => e.connectionType === "ssh" && itemMatchesQuery(e, suggestionFields, q))
      .slice(0, MAX_SUGGESTIONS);
  }, [history, value]);

  const submit = () => {
    const target = parseQuickConnect(value, defaultUser);
    if (!target) {
      toast.error("Enter a host to connect to, e.g. user@host or host:port");
      return;
    }
    const config = quickConnectConfig(target);
    onConnect(config, sessionHistoryTitle("ssh", config));
    setValue("");
    setFocused(false);
    inputRef.current?.blur();
  };

  const connectSuggestion = (entry: SessionHistoryEntry) => {
    onConnect(entry.config, entry.title);
    setValue("");
    setFocused(false);
    inputRef.current?.blur();
  };

  const showDropdown = focused && suggestions.length > 0;

  // Shared combobox keyboard navigation (#4646). Nothing is highlighted until the
  // arrow keys move into the list (exposed via aria-activedescendant, #4330), so
  // Enter submits the typed text; a changed suggestion list clears the highlight.
  const nav = useComboboxListNav({
    items: suggestions,
    onSelect: connectSuggestion,
    resetKey: suggestions,
    listId,
    autocomplete: true,
    open: showDropdown,
    onUnhandledKeyDown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        setValue("");
      }
    },
  });

  return (
    <div className="recent-sessions__quick-connect">
      <div className="recent-sessions__quick-connect-row">
        <Zap size={14} className="recent-sessions__quick-connect-icon" aria-hidden="true" />
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          // Delay so a suggestion mousedown can register before the list unmounts.
          onBlur={() => {
            if (blurTimerRef.current !== null) {
              window.clearTimeout(blurTimerRef.current);
            }
            blurTimerRef.current = window.setTimeout(() => {
              blurTimerRef.current = null;
              setFocused(false);
            }, 120);
          }}
          placeholder="user@host[:port]"
          aria-label="Quick connect"
          {...nav.inputProps}
          aria-expanded={showDropdown}
          data-testid="quick-connect-input"
        />
        <Tooltip content="Connect" side="top">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<CornerDownLeft size={14} />}
            aria-label="Connect"
            data-testid="quick-connect-submit"
            onClick={submit}
          />
        </Tooltip>
      </div>
      {showDropdown && (
        <ul
          {...nav.listboxProps}
          className="recent-sessions__autocomplete"
          aria-label="Matching sessions"
          data-testid="quick-connect-suggestions"
        >
          {suggestions.map((entry, index) => {
            // Connecting happens on mousedown (before the input's blur handler),
            // so the hook's click handler is not used here.
            const { onClick: _onClick, ...optionProps } = nav.getOptionProps(index);
            return (
              <li
                key={entry.dedupKey}
                {...optionProps}
                className={`recent-sessions__autocomplete-item${
                  index === nav.activeIndex ? " recent-sessions__autocomplete-item--active" : ""
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  connectSuggestion(entry);
                }}
                data-testid={`quick-connect-suggestion-${entry.dedupKey}`}
              >
                <span className="recent-sessions__autocomplete-title">{entry.title}</span>
                <span className="recent-sessions__autocomplete-time">
                  {formatRelativeTime(new Date(entry.lastUsed).toISOString())}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
