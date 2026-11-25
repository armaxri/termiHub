import { useCallback, useEffect, useMemo, useState } from "react";
import { matchSorter } from "match-sorter";
import { TerminalSquare, LayoutGrid, Radio, ChevronLeft, Zap } from "lucide-react";
import { collectLiveTabs, getActiveTab, useAppStore } from "@/store/appStore";
import { useActivePanelId, useLayoutRenderTree } from "@/store/layoutSelectors";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { useProjectedBroadcast } from "@/store/useProjectedBroadcast";
import { buildCommands } from "@/services/commands";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { isMacroShaped } from "@/store/slices/automationViews";
import { runBlockedReason, runBlockedShort } from "@/utils/runBlocked";
import { openRunPicker } from "@/services/contextCommands";
import { useConnectSavedConnection } from "@/hooks/useConnectSavedConnection";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { readConfigString } from "@/utils/connectionConfigFields";
import { Modal, Input, EmptyState } from "@/components/ui";
import type { Automation } from "@/types/generated/Automation";
import type { SavedConnection } from "@/types/connection";
import "./CommandPalette.css";
import { useComboboxListNav } from "@/hooks/useComboboxListNav";

/**
 * DOM id of the results listbox the combobox input controls. Option ids are
 * derived from it by {@link useComboboxListNav} (`command-palette-list-opt-<index>`),
 * referenced by the input's `aria-activedescendant` so screen readers follow
 * arrow-key navigation while DOM focus stays in the input (WAI-ARIA combobox
 * pattern, #4330).
 */
const LIST_ID = "command-palette-list";

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
      /** What else finds it; never shown. */
      aliases: string[];
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
      kind: "automation";
      key: string;
      /** The automation's name — the primary text, never behind a prefix (#5519). */
      label: string;
      /** What else finds it: the verb, its former names, its tags. */
      aliases: string[];
      automationId: string;
      /** What Enter does with it (A-048). */
      automation: Automation;
      /** Its triggers are off. */
      triggersOff: boolean;
      /** Why it cannot run; it is inert then. */
      blocked: string | null;
      /** The same in a few words, on the row (B-039). */
      blockedShort: string | null;
    }
  | {
      kind: "broadcast";
      key: string;
      label: string;
      aliases: string[];
      /**
       * Whether the broadcast group has at least one connected terminal and
       * there is an automation to pick. Disabled and non-activatable when false.
       */
      available: boolean;
      /** Tooltip explaining why the entry is disabled. */
      unavailableReason: string;
    }
  | {
      kind: "broadcast-pick";
      key: string;
      label: string;
      /** The automation to run on the broadcast group's connected terminals. */
      automationId: string;
    }
  | {
      kind: "workspace";
      key: string;
      /** The workspace's name — the primary text, never behind a prefix (#5530). */
      label: string;
      /** Secondary match key ("Launch workspace: <name>") so the verb still finds it. */
      searchText: string;
      /** The saved workspace to launch, replacing the current layout. */
      workspaceId: string;
    };

/** The palette's sub-picker, or null for the root command list. */
type PaletteMode = "root" | "broadcast";

/** What commands were called before, by action id. */
const COMMAND_ALIASES: Record<string, string[]> = {
  "toggle-macro-recording": ["Record macro"],
  "play-macro": ["Play macro", "Run macro", "Run workflow"],
};

/**
 * What else an automation is found by: the verb, and what it was called before
 * macros and workflows became automations (#5818, maintainer decision), so an old
 * habit still works. Never shown.
 */
function automationAliases({ name, tags }: Pick<Automation, "name" | "tags">): string[] {
  return [`Run automation: ${name}`, `Run macro: ${name}`, `Run workflow: ${name}`, ...tags];
}

/** What running an automation in `terminal` does: "types into bash, 5 steps" (B-040). */
function automationDoes(automation: Automation, terminal: string): string {
  const { steps } = automation;
  const local = steps.length > 0 && steps.every((s) => s.kind === "run-local-process");
  const count = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  if (local) return `runs on this computer, ${count}`;
  return isMacroShaped(automation) ? `types into ${terminal}` : `types into ${terminal}, ${count}`;
}

/** Why an entry does nothing. */
function disabledReason(entry: PaletteEntry): string | undefined {
  if (!isDisabled(entry)) return undefined;
  if (entry.kind === "broadcast") return entry.unavailableReason;
  if (entry.kind === "automation") return entry.blocked ?? undefined;
  return "Unavailable in the current context";
}

/**
 * The entry's secondary match keys: a connection's host, an automation's
 * aliases, or a workspace's "Launch workspace: <name>" phrase, so typing the
 * verb still finds an entry whose row shows only its name (#5519, #5530).
 */
function secondaryMatchKeys(entry: PaletteEntry): string | string[] {
  switch (entry.kind) {
    case "connection":
      return entry.host;
    case "command":
    case "automation":
    case "broadcast":
      return entry.aliases;
    case "workspace":
      return entry.searchText;
    default:
      return "";
  }
}

/** Whether an entry is shown but inert in the current context. */
function isDisabled(entry: PaletteEntry): boolean {
  if (entry.kind === "automation") return entry.blocked !== null;
  return (entry.kind === "command" || entry.kind === "broadcast") && !entry.available;
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
 * An automation's row starts with "Run" and says what Enter does and where ("types
 * 5 steps in prod-web", A-048); without a terminal the run picker asks where. While broadcasting, a "Run
 * automation on broadcast group" entry (#3430) opens a sub-picker; the chosen
 * automation runs on the group's connected terminals. Every run goes through
 * `runAutomation`. Backspace on an empty picker query returns to the root list.
 */
export function CommandPalette(): React.ReactElement {
  const open = useAppStore((s) => s.commandPaletteOpen);
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const { connections } = useProjectedConnections();
  const automations = useAppStore((s) => s.automations);
  const runAutomation = useAppStore((s) => s.runAutomation);
  const experimental = useExperimentalFeatures();
  // Where an automation would type (R-083): the active terminal tab's title.
  // "asks where" needs something to choose from (C-024).
  const anyTerminal = useAppStore((s) =>
    collectLiveTabs(s).some((tab) => tab.contentType === "terminal")
  );
  const recording = useAppStore((s) => s.recording !== null);
  const runTarget = useAppStore((s) => {
    const tab = getActiveTab(s);
    return tab?.contentType === "terminal" ? tab.title || "Terminal" : null;
  });
  const workspaces = useAppStore((s) => s.workspaces);
  const requestLaunchWorkspace = useAppStore((s) => s.requestLaunchWorkspace);
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

  // All entries (commands first, then connections) in declaration order — the
  // order shown when the query is empty.
  // What it does now, not what it can do (C-024).
  const recordLabel = recording
    ? "Stop recording"
    : runTarget === null
      ? "Open a terminal and record"
      : `Start recording in ${runTarget}`;
  const entries = useMemo<PaletteEntry[]>(() => {
    if (mode === "broadcast") {
      return automations.map((a) => ({
        kind: "broadcast-pick",
        key: `broadcast-pick:${a.id}`,
        label: a.name,
        automationId: a.id,
      }));
    }
    const commandEntries: PaletteEntry[] = buildCommands().map((cmd) => ({
      kind: "command",
      key: `command:${cmd.id}`,
      label: cmd.id === "toggle-macro-recording" ? recordLabel : cmd.label,
      accelerator: cmd.accelerator,
      available: cmd.available,
      aliases: [...(COMMAND_ALIASES[cmd.id] ?? []), cmd.label],
      run: cmd.run,
    }));
    const connectionEntries: PaletteEntry[] = connections.map((conn) => ({
      kind: "connection",
      key: `connection:${conn.id}`,
      label: conn.name,
      host: readConfigString(conn.config, "host") ?? "",
      connection: conn,
    }));
    const automationEntries: PaletteEntry[] = automations.map((a) => ({
      kind: "automation",
      key: `automation:${a.id}`,
      label: a.name,
      aliases: automationAliases(a),
      automationId: a.id,
      automation: a,
      triggersOff: a.triggers.length > 0 && a.triggersEnabled === false,
      blocked: runBlockedReason(a, (id) => automations.find((x) => x.id === id), experimental),
      blockedShort: runBlockedShort(a, (id) => automations.find((x) => x.id === id), experimental),
    }));
    // Only offered while broadcasting (#3430); disabled when the group has no
    // connected terminal or there is no automation to pick.
    const broadcastEntries: PaletteEntry[] = [];
    if (broadcast.active) {
      const connectedCount = getBroadcastTargetTabIds().length;
      const noun = connectedCount === 1 ? "terminal" : "terminals";
      broadcastEntries.push({
        kind: "broadcast",
        key: "broadcast",
        label: `Run automation on broadcast group (${connectedCount} ${noun})…`,
        aliases: ["Run macro on broadcast group", "Run workflow on broadcast group"],
        available: connectedCount > 0 && automations.length > 0,
        unavailableReason:
          connectedCount === 0
            ? "No connected terminals in the broadcast group"
            : "No automations to run",
      });
    }
    const workspaceEntries: PaletteEntry[] = workspaces.map((ws) => ({
      kind: "workspace",
      key: `workspace:${ws.id}`,
      label: ws.name,
      searchText: `Launch workspace: ${ws.name}`,
      workspaceId: ws.id,
    }));
    return [
      ...commandEntries,
      ...broadcastEntries,
      ...automationEntries,
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
    automations,
    experimental,
    workspaces,
    rootPanel,
    activePanelId,
    recordLabel,
  ]);

  // Ranked results. An empty query returns every entry in declaration order.
  const results = useMemo<PaletteEntry[]>(() => {
    if (query.trim() === "") return entries;
    return matchSorter(entries, query, {
      keys: ["label", secondaryMatchKeys],
    });
  }, [entries, query]);

  // Reset the query (and, via the nav hook's reset key, the selection) each
  // time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setMode("root");
    }
  }, [open]);

  const activate = useCallback(
    (entry: PaletteEntry | undefined) => {
      if (!entry) return;
      // A context-bound command with no applicable target is inert: leave the
      // palette open so the user sees it did nothing (and why, via the disabled
      // affordance) rather than silently dismissing.
      if (isDisabled(entry)) return;
      // Entering a sub-picker keeps the palette open with a fresh query.
      if (entry.kind === "broadcast") {
        setMode("broadcast");
        setQuery("");
        return;
      }
      // Close first so the palette never stacks over a follow-on dialog (e.g.
      // the password prompt a connect may trigger).
      setOpen(false);
      if (entry.kind === "command") {
        entry.run();
      } else if (entry.kind === "automation") {
        // Without a terminal there is nothing to type into: ask where.
        if (runTarget === null) openRunPicker(entry.automationId);
        else void runAutomation(entry.automationId, { origin: "palette" });
      } else if (entry.kind === "broadcast-pick") {
        // Resolve the group at run time so it reflects the latest connections.
        void runAutomation(entry.automationId, {
          targetTabIds: getBroadcastTargetTabIds(),
          origin: "palette",
        });
      } else if (entry.kind === "workspace") {
        // The shared entry point confirms first when live sessions would end (UX2-002).
        requestLaunchWorkspace(entry.workspaceId);
      } else {
        void connect(entry.connection);
      }
    },
    [connect, runAutomation, runTarget, requestLaunchWorkspace, getBroadcastTargetTabIds, setOpen]
  );

  // Backspace on an empty sub-picker query returns to the root list.
  const handleUnhandledKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Backspace" && mode !== "root" && query === "") {
        event.preventDefault();
        setMode("root");
      }
    },
    [mode, query]
  );

  const nav = useComboboxListNav({
    items: results,
    onSelect: activate,
    // Opening the palette, switching sub-picker and a new query each re-target
    // the top hit. `open` and `mode` never contain ":", so the key is unambiguous.
    resetKey: `${open}:${mode}:${query}`,
    listId: LIST_ID,
    homeEnd: true,
    onUnhandledKeyDown: handleUnhandledKeyDown,
  });

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Fuzzy-find and run a command or connect to a saved connection"
      size="lg"
      hideClose
      data-testid="command-palette"
    >
      <div className="command-palette">
        {mode === "broadcast" && (
          <button
            type="button"
            className="command-palette__picker"
            onClick={() => {
              setMode("root");
              setQuery("");
            }}
            title="Back to commands (Backspace)"
            data-testid="command-palette-picker"
          >
            <ChevronLeft size={14} aria-hidden="true" />
            Run automation on broadcast group
          </button>
        )}
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            mode === "broadcast"
              ? "Pick an automation to run on the broadcast group…"
              : "Type a command or connection…"
          }
          aria-label="Command or connection search"
          {...nav.inputProps}
          aria-expanded={results.length > 0}
          data-testid="command-palette-input"
        />
        {results.length === 0 ? (
          <EmptyState
            title={
              mode === "broadcast"
                ? "No matching automations."
                : "No matching commands or connections."
            }
            data-testid="command-palette-empty"
          />
        ) : (
          <ul
            {...nav.listboxProps}
            className="command-palette__list"
            aria-label="Commands and connections"
          >
            {results.map((entry, index) => {
              const disabled = isDisabled(entry);
              return (
                <li
                  key={entry.key}
                  {...nav.getOptionProps(index)}
                  aria-disabled={disabled || undefined}
                  className={`command-palette__item${
                    index === nav.activeIndex ? " command-palette__item--active" : ""
                  }${disabled ? " command-palette__item--disabled" : ""}`}
                  title={disabledReason(entry)}
                  data-testid={`command-palette-item-${entry.key}`}
                >
                  <span className="command-palette__icon" aria-hidden="true">
                    {entry.kind === "command" ? (
                      <TerminalSquare size={16} />
                    ) : entry.kind === "broadcast" ? (
                      <Radio size={16} />
                    ) : entry.kind === "automation" || entry.kind === "broadcast-pick" ? (
                      <Zap size={16} />
                    ) : entry.kind === "workspace" ? (
                      <LayoutGrid size={16} />
                    ) : (
                      <ConnectionIcon
                        config={entry.connection.config}
                        customIcon={entry.connection.icon}
                        iconColor={entry.connection.iconColor}
                        iconEmoji={entry.connection.iconEmoji}
                        size={16}
                      />
                    )}
                  </span>
                  <span className="command-palette__label">
                    {entry.kind === "automation" || entry.kind === "broadcast-pick" ? (
                      <span className="command-palette__verb">Run </span>
                    ) : null}
                    {entry.label}
                  </span>
                  {entry.kind === "command" ? (
                    entry.accelerator ? (
                      <span className="command-palette__accelerator">{entry.accelerator}</span>
                    ) : null
                  ) : entry.kind === "automation" ? (
                    <>
                      <span className="command-palette__target">
                        {entry.blocked !== null
                          ? `Cannot run: ${entry.blockedShort}`
                          : runTarget === null
                            ? anyTerminal
                              ? "asks where"
                              : "open a terminal first"
                            : automationDoes(entry.automation, runTarget)}
                        {entry.triggersOff ? " · triggers off" : ""}
                      </span>
                      <span className="command-palette__type">automation</span>
                    </>
                  ) : entry.kind === "broadcast" || entry.kind === "broadcast-pick" ? (
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
