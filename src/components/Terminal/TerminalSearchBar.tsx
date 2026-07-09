import { useState, useRef, useEffect, useCallback } from "react";
import { X, ChevronUp, ChevronDown, CaseSensitive, Regex } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, Tooltip } from "@/components/ui";
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
