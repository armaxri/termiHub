import { useMemo, useRef, useState } from "react";
import { CornerDownLeft, Zap } from "lucide-react";
import { Button, Input, Tooltip, toast } from "@/components/ui";
import type { ConnectionConfig } from "@/types/terminal";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import { parseQuickConnect, quickConnectConfig } from "@/utils/quickConnect";
import { sessionHistoryTitle } from "@/utils/sessionHistoryTitle";
import { formatRelativeTime } from "@/utils/formatters";

/** Maximum autocomplete suggestions shown below the quick-connect input. */
const MAX_SUGGESTIONS = 6;

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
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    return history
      .filter(
        (e) =>
          e.connectionType === "ssh" &&
          (e.title.toLowerCase().includes(q) || e.dedupKey.toLowerCase().includes(q))
      )
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
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              setValue("");
            }
          }}
          placeholder="user@host[:port]"
          aria-label="Quick connect"
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
          className="recent-sessions__autocomplete"
          role="listbox"
          aria-label="Matching sessions"
          data-testid="quick-connect-suggestions"
        >
          {suggestions.map((entry) => (
            <li key={entry.dedupKey} role="option" aria-selected={false}>
              <button
                type="button"
                className="recent-sessions__autocomplete-item"
                // Use mousedown so the connect fires before the input's blur handler.
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
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
