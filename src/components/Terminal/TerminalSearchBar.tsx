import { useState, useRef, useEffect, useCallback } from "react";
import { X, ChevronUp, ChevronDown, CaseSensitive, Regex, WholeWord } from "lucide-react";
import type { ISearchResultChangeEvent } from "@xterm/addon-search";
import { useAppStore } from "@/store/appStore";
import { Button, Input, Tooltip } from "@/components/ui";
import { useTerminalRegistry } from "./TerminalRegistry";
import "./TerminalSearchBar.css";

interface TerminalSearchBarProps {
  tabId: string;
}

/** Render the "current / total" match summary for the current search. */
function formatMatchCount(results: ISearchResultChangeEvent | null): string {
  if (!results) return "";
  if (results.resultCount === 0) return "No results";
  // `resultIndex` is -1 when no single match is selected (e.g. the highlight
  // threshold was exceeded); fall back to a plain total in that case.
  if (results.resultIndex < 0) return `${results.resultCount} matches`;
  return `${results.resultIndex + 1}/${results.resultCount}`;
}

export function TerminalSearchBar({ tabId }: TerminalSearchBarProps) {
  const visible = useAppStore((s) => s.terminalSearchVisible[tabId] ?? false);
  const setVisible = useAppStore((s) => s.setTerminalSearchVisible);
  const { findNext, findPrevious, clearSearchDecorations, focusTerminal, onSearchResults } =
    useTerminalRegistry();

  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [results, setResults] = useState<ISearchResultChangeEvent | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when search bar becomes visible
  useEffect(() => {
    if (visible) {
      // Delay slightly so the element is rendered
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [visible]);

  // Reflect the addon's match count (current index + total) in the UI.
  useEffect(() => onSearchResults(tabId, setResults), [tabId, onSearchResults]);

  // Clear decorations and the stale count when the query becomes empty.
  useEffect(() => {
    if (!query) {
      clearSearchDecorations(tabId);
      setResults(null);
    }
  }, [query, tabId, clearSearchDecorations]);

  const handleFindNext = useCallback(() => {
    if (query) findNext(tabId, query, { caseSensitive, regex: useRegex, wholeWord });
  }, [tabId, query, caseSensitive, useRegex, wholeWord, findNext]);

  const handleFindPrevious = useCallback(() => {
    if (query) findPrevious(tabId, query, { caseSensitive, regex: useRegex, wholeWord });
  }, [tabId, query, caseSensitive, useRegex, wholeWord, findPrevious]);

  const handleClose = useCallback(() => {
    setVisible(tabId, false);
    clearSearchDecorations(tabId);
    setQuery("");
    focusTerminal(tabId);
  }, [tabId, setVisible, clearSearchDecorations, focusTerminal]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Prevent terminal shortcuts from firing while typing in search
      e.stopPropagation();

      if (e.key === "Escape") {
        handleClose();
      } else if (e.key === "Enter") {
        if (e.shiftKey) {
          handleFindPrevious();
        } else {
          handleFindNext();
        }
      }
    },
    [handleClose, handleFindNext, handleFindPrevious]
  );

  // Trigger search on query/option changes
  useEffect(() => {
    if (visible && query) {
      findNext(tabId, query, { caseSensitive, regex: useRegex, wholeWord });
    }
  }, [query, caseSensitive, useRegex, wholeWord, visible, tabId, findNext]);

  const matchCount = formatMatchCount(query ? results : null);

  if (!visible) return null;

  return (
    <div className="terminal-search-bar" onKeyDown={handleKeyDown}>
      <Input
        ref={inputRef}
        className="terminal-search-bar__input"
        size="sm"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find..."
        spellCheck={false}
      />
      <span className="terminal-search-bar__count" aria-live="polite" role="status">
        {matchCount}
      </span>
      <Tooltip content="Match Case" side="bottom">
        <Button
          variant={caseSensitive ? "secondary" : "ghost"}
          size="sm"
          icon={<CaseSensitive size={14} />}
          onClick={() => setCaseSensitive(!caseSensitive)}
          aria-label="Match Case"
          aria-pressed={caseSensitive}
        />
      </Tooltip>
      <Tooltip content="Match Whole Word" side="bottom">
        <Button
          variant={wholeWord ? "secondary" : "ghost"}
          size="sm"
          icon={<WholeWord size={14} />}
          onClick={() => setWholeWord(!wholeWord)}
          aria-label="Match Whole Word"
          aria-pressed={wholeWord}
        />
      </Tooltip>
      <Tooltip content="Use Regular Expression" side="bottom">
        <Button
          variant={useRegex ? "secondary" : "ghost"}
          size="sm"
          icon={<Regex size={14} />}
          onClick={() => setUseRegex(!useRegex)}
          aria-label="Use Regular Expression"
          aria-pressed={useRegex}
        />
      </Tooltip>
      <Tooltip content="Previous" side="bottom">
        <Button
          variant="ghost"
          size="sm"
          icon={<ChevronUp size={14} />}
          onClick={handleFindPrevious}
          aria-label="Previous match"
        />
      </Tooltip>
      <Tooltip content="Next" side="bottom">
        <Button
          variant="ghost"
          size="sm"
          icon={<ChevronDown size={14} />}
          onClick={handleFindNext}
          aria-label="Next match"
        />
      </Tooltip>
      <Tooltip content="Close" side="bottom">
        <Button
          variant="ghost"
          size="sm"
          icon={<X size={14} />}
          onClick={handleClose}
          aria-label="Close search"
        />
      </Tooltip>
    </div>
  );
}
