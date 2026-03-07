import { useState, useRef, useEffect, useCallback } from "react";
import { X, ChevronUp, ChevronDown, CaseSensitive, Regex } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useTerminalRegistry } from "./TerminalRegistry";
import "./TerminalSearchBar.css";

interface TerminalSearchBarProps {
  tabId: string;
}

export function TerminalSearchBar({ tabId }: TerminalSearchBarProps) {
  const visible = useAppStore((s) => s.terminalSearchVisible[tabId] ?? false);
  const setVisible = useAppStore((s) => s.setTerminalSearchVisible);
  const { findNext, findPrevious, clearSearchDecorations, focusTerminal } = useTerminalRegistry();

  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when search bar becomes visible
  useEffect(() => {
    if (visible) {
      // Delay slightly so the element is rendered
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [visible]);

  // Clear decorations when query or options change to empty
  useEffect(() => {
    if (!query) {
      clearSearchDecorations(tabId);
    }
  }, [query, tabId, clearSearchDecorations]);

  const handleFindNext = useCallback(() => {
    if (query) findNext(tabId, query, { caseSensitive, regex: useRegex });
  }, [tabId, query, caseSensitive, useRegex, findNext]);

  const handleFindPrevious = useCallback(() => {
    if (query) findPrevious(tabId, query, { caseSensitive, regex: useRegex });
  }, [tabId, query, caseSensitive, useRegex, findPrevious]);

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
      findNext(tabId, query, { caseSensitive, regex: useRegex });
    }
  }, [query, caseSensitive, useRegex, visible, tabId, findNext]);

  if (!visible) return null;

  return (
    <div className="terminal-search-bar" onKeyDown={handleKeyDown}>
      <input
        ref={inputRef}
        className="terminal-search-bar__input"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find..."
        spellCheck={false}
      />
      <button
        className={`terminal-search-bar__btn${caseSensitive ? " terminal-search-bar__btn--active" : ""}`}
        onClick={() => setCaseSensitive(!caseSensitive)}
        title="Match Case"
      >
        <CaseSensitive size={14} />
      </button>
      <button
        className={`terminal-search-bar__btn${useRegex ? " terminal-search-bar__btn--active" : ""}`}
        onClick={() => setUseRegex(!useRegex)}
        title="Use Regular Expression"
      >
        <Regex size={14} />
      </button>
      <button className="terminal-search-bar__btn" onClick={handleFindPrevious} title="Previous">
        <ChevronUp size={14} />
      </button>
      <button className="terminal-search-bar__btn" onClick={handleFindNext} title="Next">
        <ChevronDown size={14} />
      </button>
      <button className="terminal-search-bar__btn" onClick={handleClose} title="Close">
        <X size={14} />
      </button>
    </div>
  );
}
