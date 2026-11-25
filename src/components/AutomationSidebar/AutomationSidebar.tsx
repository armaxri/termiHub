import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ArrowDownUp, CircleDot, Keyboard, ListPlus, Plus, Square } from "lucide-react";
import { getActiveTab, useAppStore } from "@/store/appStore";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { Button, EmptyState, SearchInput, toast } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { SidebarToolbar } from "@/components/Sidebar/SidebarToolbar";
import { RunTargetsDialog } from "@/components/Automations/RunTargetsDialog";
import { useScheduleLabels } from "@/components/Schedules/useScheduleLabels";
import { SchedulesSection } from "@/components/Schedules";
import { WorkflowRunOutput } from "@/components/WorkflowSidebar/WorkflowRunOutput";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import { nameDescriptionTagsFields, useListFilter } from "@/hooks/useListFilter";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { t, tf } from "@/i18n/catalog";
import type { Automation } from "@/types/generated/Automation";
import { runBlockedReason } from "@/utils/runBlocked";
import { errorMessage } from "@/utils/errorMessage";
import { AUTOMATION_JUST_SAVED_MS, AutomationRow } from "./AutomationRow";
import type { AutomationRowActions } from "./AutomationRowMenu";
import { HistorySection } from "./HistorySection";
import { nextScheduledRun, summarizeRuns, triggerState } from "./automationRowInfo";
import { useAutomationSections } from "./automationSections";
import { useAutomationEditors } from "./useAutomationEditors";
import { useAutomationFiles } from "@/components/Automations/useAutomationFiles";
import { useRunningAutomations } from "./useRunningAutomations";
import "./AutomationSidebar.css";

/**
 * Sidebar content width (px) below which the rows' markers drop their words and
 * show as icons: the name, a marker, the switch and Run no longer fit on one
 * line with a readable name under it.
 */
const AUTOMATIONS_COMPACT_WIDTH = 240;

const NO_TARGETS: never[] = [];

/**
 * The Automations sidebar (#5818, slice 6): the one place to find, run and
 * create an automation. It replaces the Macros and Workflows sidebars.
 *
 * Toolbar: New (step by step, typed keystrokes, and a link to import and export,
 * which live in the settings) and Record, every one named in text (R-037) and both
 * in view at every width. The list holds every
 * automation, searchable by name, description and tag; rows show names and
 * state, never settings. Below it, the collapsible Schedules and History
 * sections and the output of a running local process.
 */
export function AutomationSidebar() {
  const automations = useAppStore((s) => s.automations);
  const automationRuns = useAppStore((s) => s.automationRuns);
  const runAutomation = useAppStore((s) => s.runAutomation);
  const duplicateAutomation = useAppStore((s) => s.duplicateAutomation);
  const deleteAutomationFromBackend = useAppStore((s) => s.deleteAutomationFromBackend);
  const setWorkflowTriggersEnabled = useAppStore((s) => s.setWorkflowTriggersEnabled);
  const cancelWorkflowRun = useAppStore((s) => s.cancelWorkflowRun);
  const cancelMacroPlayback = useAppStore((s) => s.cancelMacroPlayback);
  const openScheduleEditor = useAppStore((s) => s.openScheduleEditor);
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const toggleRecording = useAppStore((s) => s.toggleRecording);
  const recordInNewTerminal = useAppStore((s) => s.recordInNewTerminal);
  const recording = useAppStore((s) => s.recording !== null);
  const recordingIntoEditor = useAppStore((s) => s.recording?.intoEditor != null);
  // Where Run types (R-113, R-119): the active terminal tab's title.
  const runTarget = useAppStore((s) => {
    const tab = getActiveTab(s);
    return tab?.contentType === "terminal" ? tab.title || "Terminal" : null;
  });
  const { connections } = useProjectedConnections();
  const connectionName = useMemo(() => {
    const names = new Map(connections.map((c) => [c.id, c.name]));
    return (id: string) => names.get(id);
  }, [connections]);
  const runSummaries = useMemo(() => summarizeRuns(automationRuns), [automationRuns]);
  const running = useRunningAutomations();
  const schedules = useAppStore((s) => s.schedules);
  const { blockedShort } = useScheduleLabels();
  const schedulesPaused = useAppStore((s) => s.schedulesPaused);
  const experimental = useExperimentalFeatures();
  const resolve = useCallback((id: string) => automations.find((a) => a.id === id), [automations]);

  const historyAutomationId = useAutomationSections((s) => s.historyAutomationId);
  const setHistoryAutomationId = useAutomationSections((s) => s.setHistoryAutomationId);
  const showHistoryOf = useAutomationSections((s) => s.showHistoryOf);
  const historyOpen = useAutomationSections((s) => s.historyOpen);
  const setHistoryOpen = useAutomationSections((s) => s.setHistoryOpen);
  const schedulesOpen = useAutomationSections((s) => s.schedulesOpen);
  const setSchedulesOpen = useAutomationSections((s) => s.setSchedulesOpen);

  const { query, setQuery, filtered } = useListFilter(automations, nameDescriptionTagsFields);
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  const compact = width !== null && width < AUTOMATIONS_COMPACT_WIDTH;

  // The row just saved (from the editor or a recording), marked briefly so the
  // user sees which one changed (#5687). What was saved before is not marked.
  const saved = useAutomationSections((s) => s.saved);
  const [unmarkedSeq, setUnmarkedSeq] = useState(saved?.seq ?? 0);
  const justSaved = saved && saved.seq > unmarkedSeq ? saved : null;
  const scrolledSeq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  const { exportOne } = useAutomationFiles();

  const deletion = useDeleteConfirm<{ id: string; name: string }>(async ({ id }) => {
    try {
      await deleteAutomationFromBackend(id);
    } catch (err) {
      toast.error(`Failed to delete automation: ${errorMessage(err)}`);
    }
  });
  const requestDelete = deletion.request;

  // "Run on…" (#5818, slice 5): the run picker for one automation.
  const [runOnId, setRunOnId] = useState<string | null>(null);
  const runOnItems = useMemo(() => {
    const automation = automations.find((a) => a.id === runOnId);
    return automation
      ? [{ id: automation.id, name: automation.name, stepCount: automation.steps.length }]
      : [];
  }, [automations, runOnId]);

  const handleRun = useCallback(
    (id: string) => {
      // Without an active terminal there is nothing to type into: ask where.
      if (runTarget === null) setRunOnId(id);
      else void runAutomation(id);
    },
    [runAutomation, runTarget]
  );

  const { edit, newFromAutomation, newFromKeys, newFromSteps } = useAutomationEditors();

  const handleStop = useCallback(
    (id: string) => {
      if (useAppStore.getState().macroPlayback?.macroId === id) cancelMacroPlayback();
      // Everything, so no queued terminal of a fan-out starts (#3418). Only one
      // step-by-step automation runs at a time.
      else cancelWorkflowRun();
    },
    [cancelMacroPlayback, cancelWorkflowRun]
  );

  const handleSetTriggers = useCallback(
    async (id: string, on: boolean) => {
      const name = automations.find((a) => a.id === id)?.name ?? "automation";
      try {
        await setWorkflowTriggersEnabled(id, on);
      } catch (err) {
        toast.error(tf("automation.triggers.toggleFailed", { name }), {
          description: errorMessage(err),
        });
      }
    },
    [automations, setWorkflowTriggersEnabled]
  );

  const actions = useMemo<AutomationRowActions>(
    () => ({
      onRun: handleRun,
      onStop: handleStop,
      onRunOn: setRunOnId,
      onEdit: edit,
      onSchedule: (id) => openScheduleEditor({ action: { kind: "automation", automationId: id } }),
      onShowHistory: showHistoryOf,
      onDuplicate: (id) => {
        const name = automations.find((a) => a.id === id)?.name ?? "automation";
        duplicateAutomation(id).catch((err: unknown) =>
          toast.error(`Failed to duplicate “${name}”`, { description: errorMessage(err) })
        );
      },
      onUseInNew: newFromAutomation,
      onExport: exportOne,
      onDelete: (id) => {
        const automation = automations.find((a) => a.id === id);
        if (automation) requestDelete({ id: automation.id, name: automation.name });
      },
    }),
    [
      automations,
      duplicateAutomation,
      edit,
      exportOne,
      handleRun,
      handleStop,
      newFromAutomation,
      openScheduleEditor,
      requestDelete,
      showHistoryOf,
    ]
  );

  // Unmark the saved row once its highlight has played out (#5687).
  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setUnmarkedSeq(justSaved.seq), AUTOMATION_JUST_SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  // Bring the saved row into view once it renders (a new automation's row may
  // appear a beat after the save resolves). Scroll once per save, so the list
  // is not pulled back while the user scrolls during the highlight.
  useEffect(() => {
    if (!justSaved || scrolledSeq.current === justSaved.seq) return;
    const rowTestId = `automation-item-${justSaved.id}`;
    const row = Array.from(listRef.current?.children ?? []).find(
      (el) => el.getAttribute("data-testid") === rowTestId
    );
    if (!(row instanceof HTMLElement)) return;
    scrolledSeq.current = justSaved.seq;
    row.scrollIntoView?.({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, [justSaved, filtered, reducedMotion]);

  // Roving-tabindex keyboard navigation over the filtered list, matching the
  // other management sidebars. Enter opens the editor, like a double-click:
  // nothing but Run types into a terminal (#6026). Ctrl/Cmd+Enter is Run.
  const handleActivate = useCallback((automation: Automation) => edit(automation.id), [edit]);
  const nav = useFlatRovingNav<Automation, HTMLDivElement>(
    filtered,
    (automation) => automation.name,
    handleActivate
  );
  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // A row's open menu is portaled out of the list, but its key events reach
    // here through the React tree: Enter on "Delete…" must not run the row.
    if (!e.currentTarget.contains(target)) return;
    // Enter and typing on a row's own button belong to the button.
    const onRow = target.getAttribute("role") === "treeitem";
    if (!onRow && (e.key === "Enter" || e.key.length === 1)) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const automation = filtered[nav.activeIndex];
      if (!automation || e.repeat || running.has(automation.id)) return;
      if (runBlockedReason(automation, resolve, experimental) === null) handleRun(automation.id);
      return;
    }
    nav.onKeyDown(e);
  };

  return (
    <div ref={rootRef} className="automation-sidebar" data-testid="automation-sidebar">
      <SidebarToolbar
        align="center"
        aria-label="Automation actions"
        overflowLabel="More automation actions"
        overflowTestId="automation-toolbar-overflow"
        actions={[
          {
            id: "new",
            label: "New automation",
            shortLabel: "New",
            icon: <Plus size={12} />,
            primary: true,
            testId: "automation-new-btn",
            menu: [
              {
                id: "steps",
                label: "Step by step…",
                icon: <ListPlus size={14} />,
                onSelect: newFromSteps,
                testId: "automation-new-steps",
              },
              {
                id: "keys",
                label: "Typed keystrokes…",
                icon: <Keyboard size={14} />,
                onSelect: newFromKeys,
                testId: "automation-new-keys",
              },
              { type: "separator", id: "files-sep" },
              {
                id: "files",
                label: "Import or export…",
                icon: <ArrowDownUp size={14} />,
                onSelect: () => openSettingsTab({ category: "import" }),
                testId: "automation-files-btn",
              },
            ],
          },
          {
            id: "record",
            label: recording && !recordingIntoEditor ? "Stop recording" : "Record",
            tooltip: recordingIntoEditor
              ? "The bar above the terminals stops it and returns to the automation"
              : recording
                ? "Stop recording and name the automation"
                : runTarget === null
                  ? "Open a terminal and record"
                  : `Record what you type in ${runTarget}`,
            disabled: recordingIntoEditor,
            icon:
              recording && !recordingIntoEditor ? (
                <Square
                  size={12}
                  fill="currentColor"
                  className="automation-sidebar__stop-recording"
                />
              ) : (
                <CircleDot size={12} />
              ),
            // Without a terminal it opens one (B-028).
            onClick:
              !recording && runTarget === null ? () => void recordInNewTerminal() : toggleRecording,
            testId: "automation-record-btn",
          },
        ]}
      />
      <div className="automation-sidebar__search">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search automations"
          aria-label="Search automations"
          clearLabel="Clear automation search"
          data-testid="automation-search"
        />
      </div>
      {automations.length === 0 ? (
        <div className="automation-sidebar__list">
          <EmptyState
            title={t("automation.empty.title")}
            description={t("automation.empty.description")}
            action={
              <>
                <Button
                  size="sm"
                  icon={<CircleDot size={14} />}
                  onClick={
                    !recording && runTarget === null
                      ? () => void recordInNewTerminal()
                      : toggleRecording
                  }
                  data-testid="automation-empty-record-btn"
                >
                  {recording
                    ? "Stop recording"
                    : runTarget === null
                      ? "Open a terminal and record"
                      : "Record"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ListPlus size={14} />}
                  onClick={newFromSteps}
                  data-testid="automation-empty-new-btn"
                >
                  New step by step
                </Button>
              </>
            }
            data-testid="automation-empty"
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="automation-sidebar__list">
          <EmptyState
            title={tf("automation.noResults", { query: query.trim() })}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setQuery("")}
                data-testid="automation-clear-search-btn"
              >
                Clear search
              </Button>
            }
            data-testid="automation-no-results"
          />
        </div>
      ) : (
        <div
          ref={listRef}
          className="automation-sidebar__list"
          data-testid="automation-list"
          role="tree"
          aria-label="Automations"
          onKeyDown={handleListKeyDown}
        >
          {filtered.map((automation, index) => (
            <AutomationRow
              key={automation.id}
              automation={automation}
              targets={running.get(automation.id) ?? NO_TARGETS}
              runs={runSummaries.get(automation.id)}
              runTarget={runTarget}
              compact={compact}
              connectionName={connectionName}
              blocked={runBlockedReason(automation, resolve, experimental)}
              nextRun={nextScheduledRun(
                automation.id,
                schedules,
                schedulesPaused,
                blockedShort,
                triggerState(automation, connectionName)?.on === false
              )}
              onSetTriggers={(id, on) => void handleSetTriggers(id, on)}
              actions={actions}
              justSaved={justSaved?.id === automation.id}
              rowProps={nav.getItemProps(index)}
            />
          ))}
        </div>
      )}
      <SchedulesSection collapse={{ expanded: schedulesOpen, onChange: setSchedulesOpen }} />
      <HistorySection
        automationId={historyAutomationId}
        onFilterChange={setHistoryAutomationId}
        collapse={{ expanded: historyOpen, onChange: setHistoryOpen }}
      />
      <WorkflowRunOutput />
      <RunTargetsDialog
        open={runOnId !== null}
        automations={runOnItems}
        emptyText="This automation no longer exists."
        onOpenChange={(open) => {
          if (!open) setRunOnId(null);
        }}
        onRun={(id, targetTabIds, { parallel }) =>
          void runAutomation(id, { targetTabIds, parallel })
        }
      />
      <ConfirmDeleteDialog
        {...deletion.dialogProps}
        message={
          deletion.pending
            ? `Delete automation “${deletion.pending.name}”? This cannot be undone.`
            : ""
        }
      />
    </div>
  );
}
