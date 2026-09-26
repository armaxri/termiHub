import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchSorter } from "match-sorter";
import {
  TerminalSquare,
  Play,
  Workflow as WorkflowIcon,
  LayoutGrid,
  Radio,
  ChevronLeft,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useActivePanelId, useLayoutRenderTree } from "@/store/layoutSelectors";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { useProjectedBroadcast } from "@/store/useProjectedBroadcast";
import { buildCommands } from "@/services/commands";
import { useConnectSavedConnection } from "@/hooks/useConnectSavedConnection";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { readConfigString } from "@/utils/connectionConfigFields";
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
    }
  | {
      kind: "broadcast-workflow";
      key: string;
      label: string;
      /**
       * Whether the broadcast group has at least one connected terminal and
       * there is a workflow to pick. Disabled and non-activatable when false.
       */
      available: boolean;
      /** Tooltip explaining why the entry is disabled. */
      unavailableReason: string;
    }
  | {
      kind: "broadcast-workflow-pick";
      key: string;
      label: string;
      /** The workflow to run on the broadcast group's connected terminals. */
      workflowId: string;
    }
  | {
      kind: "workspace";
      key: string;
      label: string;
      /** The saved workspace to launch, replacing the current layout. */
      workspaceId: string;
    };

/** The palette's sub-picker, or null for the root command list. */
type PaletteMode = "root" | "broadcast-workflow";

/** Whether an entry is shown but inert in the current context. */
function isDisabled(entry: PaletteEntry): boolean {
  return (entry.kind === "command" || entry.kind === "broadcast-workflow") && !entry.available;
}

/**
 * Command palette (Cmd/Ctrl+P): a keyboard-first modal that fuzzy-matches both
 * application commands and saved connections in one ranked list. Enter runs the
 * highlighted command or connects the highlighted connection; Arrow keys move
 * the selection and Esc closes (via the shared Modal).
 *
 * Composed from the shared {@link Modal} + {@link Input} primitives; matching is
 * delegated to `match-sorter`. Connecting reuses {@link useConnectSavedConnection}
 * so the palette shares the sidebar's exact credential flow.
 *
 * While broadcasting, a "Run Workflow on Broadcast Group" entry (#3430) opens a
 * workflow sub-picker; the chosen workflow runs concurrently on the group's
 * connected terminals via `runWorkflow(id, { targetTabIds })`, which owns the
 * progress toast and per-target run history. Backspace on an empty picker
 * query returns to the root list.
 */
export function CommandPalette(): React.ReactElement {
  const open = useAppStore((s) => s.commandPaletteOpen);
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const { connections } = useProjectedConnections();
  const macros = useAppStore((s) => s.macros);
  const workflows = useAppStore((s) => s.workflows);
  const workspaces = useAppStore((s) => s.workspaces);
  const playMacro = useAppStore((s) => s.playMacro);
  const runWorkflow = useAppStore((s) => s.runWorkflow);
  const launchWorkspace = useAppStore((s) => s.launchWorkspace);
  const getBroadcastTargetTabIds = useAppStore((s) => s.getBroadcastTargetTabIds);
  // Subscribed so the broadcast entry appears/disappears as broadcasting toggles.
  const broadcast = useProjectedBroadcast();
  // Context-bound command availability depends on live panel/terminal state;
  // subscribe so the entry list (and its disabled affordances) recompute when
  // the focused panel, its tabs, or the active panel change.
  const rootPanel = useLayoutRenderTree();
  const activePanelId = useActivePanelId();
  const { connect } = useConnectSavedConnection();

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<PaletteMode>("root");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // All entries (commands first, then connections) in declaration order — the
  // order shown when the query is empty.
  const entries = useMemo<PaletteEntry[]>(() => {
    if (mode === "broadcast-workflow") {
      return workflows.map((w) => ({
        kind: "broadcast-workflow-pick",
        key: `broadcast-workflow-pick:${w.id}`,
        label: w.name,
        workflowId: w.id,
      }));
    }
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
      host: readConfigString(conn.config, "host") ?? "",
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
    // Only offered while broadcasting (#3430); disabled when the group has no
    // connected terminal or there is no workflow to pick.
    const broadcastEntries: PaletteEntry[] = [];
    if (broadcast.active) {
      const connectedCount = getBroadcastTargetTabIds().length;
      const noun = connectedCount === 1 ? "terminal" : "terminals";
      broadcastEntries.push({
        kind: "broadcast-workflow",
        key: "broadcast-workflow",
        label: `Run Workflow on Broadcast Group (${connectedCount} ${noun})…`,
        available: connectedCount > 0 && workflows.length > 0,
        unavailableReason:
          connectedCount === 0
            ? "No connected terminals in the broadcast group"
            : "No workflows to run",
      });
    }
    const workspaceEntries: PaletteEntry[] = workspaces.map((ws) => ({
      kind: "workspace",
      key: `workspace:${ws.id}`,
      label: `Launch Workspace: ${ws.name}`,
      workspaceId: ws.id,
    }));
    return [
      ...commandEntries,
      ...macroEntries,
      ...broadcastEntries,
      ...workflowEntries,
      ...workspaceEntries,
      ...connectionEntries,
    ];
    // buildCommands() reads live panel/terminal state via the store to compute
    // each context command's availability; rootPanel and activePanelId are listed
    // so the entries (and their disabled affordances) recompute when focus moves,
    // even though they are not referenced directly in this closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    open,
    broadcast,
    getBroadcastTargetTabIds,
    connections,
    macros,
    workflows,
    workspaces,
    rootPanel,
    activePanelId,
  ]);

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
      setMode("root");
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
      if (isDisabled(entry)) return;
      // Entering a sub-picker keeps the palette open with a fresh query.
      if (entry.kind === "broadcast-workflow") {
        setMode("broadcast-workflow");
        setQuery("");
        setActiveIndex(0);
        return;
      }
      // Close first so the palette never stacks over a follow-on dialog (e.g.
      // the password prompt a connect may trigger).
      setOpen(false);
      if (entry.kind === "command") {
        entry.run();
      } else if (entry.kind === "macro") {
        void playMacro(entry.macroId, { timingMode: "real-time" });
      } else if (entry.kind === "workflow") {
        void runWorkflow(entry.workflowId);
      } else if (entry.kind === "broadcast-workflow-pick") {
        // Resolve the group at run time so it reflects the latest connections.
        void runWorkflow(entry.workflowId, { targetTabIds: getBroadcastTargetTabIds() });
      } else if (entry.kind === "workspace") {
        void launchWorkspace(entry.workspaceId);
      } else {
        void connect(entry.connection);
      }
    },
    [connect, playMacro, runWorkflow, launchWorkspace, getBroadcastTargetTabIds, setOpen]
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
      } else if (event.key === "Backspace" && mode !== "root" && query === "") {
        event.preventDefault();
        setMode("root");
        setActiveIndex(0);
      }
    },
    [results, activeIndex, activate, mode, query]
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
        {mode === "broadcast-workflow" && (
          <button
            type="button"
            className="command-palette__picker"
            onClick={() => {
              setMode("root");
              setQuery("");
              setActiveIndex(0);
            }}
            title="Back to commands (Backspace)"
            data-testid="command-palette-picker"
          >
            <ChevronLeft size={14} aria-hidden="true" />
            Run Workflow on Broadcast Group
          </button>
        )}
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            mode === "broadcast-workflow"
              ? "Pick a workflow to run on the broadcast group…"
              : "Type a command or connection…"
          }
          aria-label="Command or connection search"
          role="combobox"
          aria-expanded
          aria-controls="command-palette-list"
          data-testid="command-palette-input"
        />
        {results.length === 0 ? (
          <p className="command-palette__empty" role="status">
            {mode === "broadcast-workflow"
              ? "No matching workflows."
              : "No matching commands or connections."}
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
              const disabled = isDisabled(entry);
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
                  title={
                    disabled
                      ? entry.kind === "broadcast-workflow"
                        ? entry.unavailableReason
                        : "Unavailable in the current context"
                      : undefined
                  }
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => activate(entry)}
                  data-testid={`command-palette-item-${entry.key}`}
                >
                  <span className="command-palette__icon" aria-hidden="true">
                    {entry.kind === "command" ? (
                      <TerminalSquare size={16} />
                    ) : entry.kind === "macro" ? (
                      <Play size={16} />
                    ) : entry.kind === "broadcast-workflow" ? (
                      <Radio size={16} />
                    ) : entry.kind === "workflow" || entry.kind === "broadcast-workflow-pick" ? (
                      <WorkflowIcon size={16} />
                    ) : entry.kind === "workspace" ? (
                      <LayoutGrid size={16} />
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
                  ) : entry.kind === "workflow" || entry.kind === "broadcast-workflow" ? (
                    <span className="command-palette__type">workflow</span>
                  ) : entry.kind === "broadcast-workflow-pick" ? (
                    <span className="command-palette__type">broadcast</span>
                  ) : entry.kind === "workspace" ? (
                    <span className="command-palette__type">workspace</span>
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
