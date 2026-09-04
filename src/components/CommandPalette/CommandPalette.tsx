import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchSorter } from "match-sorter";
import { TerminalSquare, Play, Workflow as WorkflowIcon } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useActivePanelId, useLayoutRenderTree } from "@/store/layoutSelectors";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { buildCommands } from "@/services/commands";
import { useConnectSavedConnection } from "@/hooks/useConnectSavedConnection";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { Modal, Input } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";
import "./CommandPalette.css";

/** A single fuzzy-matchable palette entry — either a command or a saved connection. */
type PaletteEntry =
  | {
      kind: "command";
      /** Stable React/list key. */
      key: string;
      /** Primary text shown and matched against. */
      label: string;
      /** Effective accelerator string, or null. */
      accelerator: string | null;
      /**
       * Whether the command has an applicable target in the current context.
       * Context-bound commands (focus-panel, tab close/next/prev, terminal
       * find/clear) are disabled and non-activatable when false.
       */
      available: boolean;
      /** Activate the entry. */
      run: () => void;
    }
  | {
      kind: "connection";
      key: string;
      label: string;
      /** Host used as a secondary match key, if any. */
      host: string;
      connection: SavedConnection;
    }
  | {
      kind: "macro";
      key: string;
      label: string;
      /** The macro to replay into the active terminal. */
      macroId: string;
    }
  | {
      kind: "workflow";
      key: string;
      label: string;
      /** The workflow to run against the active terminal (manual trigger). */
      workflowId: string;
    };

/**
 * Command palette (Cmd/Ctrl+P): a keyboard-first modal that fuzzy-matches both
 * application commands and saved connections in one ranked list. Enter runs the
 * highlighted command or connects the highlighted connection; Arrow keys move
 * the selection and Esc closes (via the shared Modal).
 *
 * Composed from the shared {@link Modal} + {@link Input} primitives; matching is
 * delegated to `match-sorter`. Connecting reuses {@link useConnectSavedConnection}
 * so the palette shares the sidebar's exact credential flow.
 */
export function CommandPalette(): React.ReactElement {
  const open = useAppStore((s) => s.commandPaletteOpen);
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const { connections } = useProjectedConnections();
  const macros = useAppStore((s) => s.macros);
  const workflows = useAppStore((s) => s.workflows);
  const playMacro = useAppStore((s) => s.playMacro);
  const runWorkflow = useAppStore((s) => s.runWorkflow);
  // Context-bound command availability depends on live panel/terminal state;
  // subscribe so the entry list (and its disabled affordances) recompute when
  // the focused panel, its tabs, or the active panel change.
  const rootPanel = useLayoutRenderTree();
  const activePanelId = useActivePanelId();
  const { connect } = useConnectSavedConnection();

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // All entries (commands first, then connections) in declaration order — the
  // order shown when the query is empty.
  const entries = useMemo<PaletteEntry[]>(() => {
    const commandEntries: PaletteEntry[] = buildCommands().map((cmd) => ({
      kind: "command",
      key: `command:${cmd.id}`,
      label: cmd.label,
      accelerator: cmd.accelerator,
      available: cmd.available,
      run: cmd.run,
    }));
    const connectionEntries: PaletteEntry[] = connections.map((conn) => ({
      kind: "connection",
      key: `connection:${conn.id}`,
      label: conn.name,
      host: String((conn.config.config as Record<string, unknown>).host ?? ""),
      connection: conn,
    }));
    const macroEntries: PaletteEntry[] = macros.map((m) => ({
      kind: "macro",
      key: `macro:${m.id}`,
      label: `Run Macro: ${m.name}`,
      macroId: m.id,
    }));
    const workflowEntries: PaletteEntry[] = workflows.map((w) => ({
      kind: "workflow",
      key: `workflow:${w.id}`,
      label: `Run Workflow: ${w.name}`,
      workflowId: w.id,
    }));
    return [...commandEntries, ...macroEntries, ...workflowEntries, ...connectionEntries];
    // buildCommands() reads live panel/terminal state via the store to compute
    // each context command's availability; rootPanel and activePanelId are listed
    // so the entries (and their disabled affordances) recompute when focus moves,
    // even though they are not referenced directly in this closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, macros, workflows, rootPanel, activePanelId]);

  // Ranked results. An empty query returns every entry in declaration order.
  const results = useMemo<PaletteEntry[]>(() => {
    if (query.trim() === "") return entries;
    return matchSorter(entries, query, {
      keys: ["label", (entry) => (entry.kind === "connection" ? entry.host : "")],
    });
  }, [entries, query]);

  // Reset the query and selection each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  // Keep the selection in range and pointed at the top hit as results change.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results]);

  const activate = useCallback(
    (entry: PaletteEntry | undefined) => {
      if (!entry) return;
      // A context-bound command with no applicable target is inert: leave the
      // palette open so the user sees it did nothing (and why, via the disabled
      // affordance) rather than silently dismissing.
      if (entry.kind === "command" && !entry.available) return;
      // Close first so the palette never stacks over a follow-on dialog (e.g.
      // the password prompt a connect may trigger).
      setOpen(false);
      if (entry.kind === "command") {
        entry.run();
      } else if (entry.kind === "macro") {
        void playMacro(entry.macroId, { timingMode: "real-time" });
      } else if (entry.kind === "workflow") {
        void runWorkflow(entry.workflowId);
      } else {
        void connect(entry.connection);
      }
    },
    [connect, playMacro, runWorkflow, setOpen]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) =>
          results.length === 0 ? 0 : (i - 1 + results.length) % results.length
        );
      } else if (event.key === "Home") {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setActiveIndex(Math.max(0, results.length - 1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        activate(results[activeIndex]);
      }
    },
    [results, activeIndex, activate]
  );

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title="Command Palette"
      description="Fuzzy-find and run a command or connect to a saved connection"
      size="lg"
      hideClose
      data-testid="command-palette"
    >
      <div className="command-palette">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command or connection…"
          aria-label="Command or connection search"
          role="combobox"
          aria-expanded
          aria-controls="command-palette-list"
          data-testid="command-palette-input"
        />
        {results.length === 0 ? (
          <p className="command-palette__empty" role="status">
            No matching commands or connections.
          </p>
        ) : (
          <ul
            id="command-palette-list"
            className="command-palette__list"
            role="listbox"
            aria-label="Commands and connections"
            ref={listRef}
          >
            {results.map((entry, index) => {
              const disabled = entry.kind === "command" && !entry.available;
              return (
                <li
                  key={entry.key}
                  data-index={index}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-disabled={disabled || undefined}
                  className={`command-palette__item${
                    index === activeIndex ? " command-palette__item--active" : ""
                  }${disabled ? " command-palette__item--disabled" : ""}`}
                  title={disabled ? "Unavailable in the current context" : undefined}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => activate(entry)}
                  data-testid={`command-palette-item-${entry.key}`}
                >
                  <span className="command-palette__icon" aria-hidden="true">
                    {entry.kind === "command" ? (
                      <TerminalSquare size={16} />
                    ) : entry.kind === "macro" ? (
                      <Play size={16} />
                    ) : entry.kind === "workflow" ? (
                      <WorkflowIcon size={16} />
                    ) : (
                      <ConnectionIcon
                        config={entry.connection.config}
                        customIcon={entry.connection.icon}
                        size={16}
                      />
                    )}
                  </span>
                  <span className="command-palette__label">{entry.label}</span>
                  {entry.kind === "command" ? (
                    entry.accelerator ? (
                      <span className="command-palette__accelerator">{entry.accelerator}</span>
                    ) : null
                  ) : entry.kind === "macro" ? (
                    <span className="command-palette__type">macro</span>
                  ) : entry.kind === "workflow" ? (
                    <span className="command-palette__type">workflow</span>
                  ) : (
                    <span className="command-palette__type">{entry.connection.config.type}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
