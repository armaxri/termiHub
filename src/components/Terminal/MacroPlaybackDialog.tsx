import { useEffect, useMemo, useState } from "react";
import { Modal, Button, Field, Select, EmptyState } from "@/components/ui";
import type { Macro } from "@/types/macro";
import type { MacroTimingMode } from "@/services/macroPlayback";
import { ACTIVE_TERMINAL_TARGET, useMacroPlaybackTargets } from "./useMacroPlaybackTargets";
import "./MacroPlaybackDialog.css";

export interface MacroPlaybackDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The stored macros available to play. */
  macros: Macro[];
  /** Called when the dialog should open/close. */
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the chosen macro id and timing mode when the user hits Play.
   * `targetTabIds` is passed only when the user picked a multi-terminal target
   * (PROD-042) and confirmed it; omitted, playback goes to the active terminal.
   */
  onPlay: (macroId: string, timingMode: MacroTimingMode, targetTabIds?: string[]) => void;
}

/** Human-readable labels for each timing mode, shown in the mode picker. */
const TIMING_MODE_OPTIONS: { value: MacroTimingMode; label: string }[] = [
  { value: "real-time", label: "Real-time (recorded delays)" },
  { value: "fixed", label: "Fixed delay per step" },
  { value: "instant", label: "Instant (no delay)" },
];

/**
 * Picker shown from the terminal toolbar's "Play Macro" action: choose a stored
 * macro, a timing mode and a target, then replay it. Composed from the shared UI
 * primitives. When no macros exist the dialog explains how to record one rather
 * than presenting an empty, un-actionable list.
 *
 * The target defaults to the active terminal on every open. Picking a
 * multi-terminal target (the live broadcast set, all terminals, the current
 * panel, or a saved broadcast group — PROD-042) never plays straight away: Play
 * turns into "Play on N terminals…" and opens a confirmation step that names
 * every receiving terminal. That step ignores Enter, so a double Enter can
 * never send keystrokes to a fleet by accident.
 */
export function MacroPlaybackDialog({
  open,
  macros,
  onOpenChange,
  onPlay,
}: MacroPlaybackDialogProps) {
  const [macroId, setMacroId] = useState<string | undefined>(undefined);
  const [timingMode, setTimingMode] = useState<MacroTimingMode>("real-time");
  const [targetValue, setTargetValue] = useState<string>(ACTIVE_TERMINAL_TARGET);
  const [confirming, setConfirming] = useState(false);
  const targets = useMacroPlaybackTargets();

  // Default the selection to the first macro each time the dialog opens so Play
  // is immediately actionable; reset the mode and the target to the safe
  // defaults (never remember a multi-terminal target across opens).
  useEffect(() => {
    if (open) {
      setMacroId(macros[0]?.id);
      setTimingMode("real-time");
      setTargetValue(ACTIVE_TERMINAL_TARGET);
      setConfirming(false);
    }
  }, [open, macros]);

  const macroOptions = useMemo(() => macros.map((m) => ({ value: m.id, label: m.name })), [macros]);

  const selected = macros.find((m) => m.id === macroId) ?? null;
  const target = targets.find((t) => t.value === targetValue) ?? targets[0];
  const isMulti = target.value !== ACTIVE_TERMINAL_TARGET;
  const targetCount = target.tabIds.length;
  const canPlay = selected !== null && selected.steps.length > 0 && (!isMulti || targetCount > 0);
  const needsConfirm = isMulti && targetCount > 1;

  const play = () => {
    if (!macroId || !canPlay) return;
    if (isMulti) onPlay(macroId, timingMode, target.tabIds);
    else onPlay(macroId, timingMode);
    onOpenChange(false);
  };

  const handlePlay = () => {
    if (!canPlay) return;
    if (needsConfirm && !confirming) {
      setConfirming(true);
      return;
    }
    play();
  };

  const playLabel = needsConfirm
    ? confirming
      ? `Send to ${targetCount} terminals`
      : `Play on ${targetCount} terminals…`
    : "Play";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Play Macro"
      description="Replay a stored macro's input into the active terminal"
      onKeyDown={(e) => {
        // Enter that a focused control already consumed (e.g. opening a Select)
        // must not also play. The multi-terminal confirmation ignores Enter
        // entirely: sending keystrokes to many hosts needs an explicit click.
        if (e.defaultPrevented) return;
        if (e.key === "Enter" && canPlay && !confirming) handlePlay();
      }}
      data-testid="macro-playback-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => (confirming ? setConfirming(false) : onOpenChange(false))}
            data-testid="macro-playback-cancel"
          >
            {confirming ? "Back" : "Cancel"}
          </Button>
          <Button
            variant={confirming ? "danger" : "primary"}
            onClick={handlePlay}
            disabled={!canPlay}
            data-testid="macro-playback-confirm"
          >
            {playLabel}
          </Button>
        </>
      }
    >
      {confirming && selected ? (
        <div className="macro-playback-dialog__confirm" data-testid="macro-playback-multi-confirm">
          <p className="macro-playback-dialog__warning" role="alert">
            {`"${selected.name}" (${selected.steps.length} steps) will be typed into ${targetCount} terminals at once:`}
          </p>
          <ul className="macro-playback-dialog__targets" data-testid="macro-playback-target-list">
            {target.titles.map((title, i) => (
              <li key={target.tabIds[i]}>{title}</li>
            ))}
          </ul>
        </div>
      ) : macros.length === 0 ? (
        <EmptyState title="No macros saved yet. Record one with the terminal toolbar's record button first." />
      ) : (
        <>
          <Field label="Macro" htmlFor="macro-playback-select">
            <Select
              value={macroId}
              onChange={setMacroId}
              options={macroOptions}
              placeholder="Select a macro"
              aria-label="Macro to play"
              data-testid="macro-playback-select"
            />
          </Field>
          <Field label="Timing" htmlFor="macro-playback-timing">
            <Select
              value={timingMode}
              onChange={(v) => setTimingMode(v as MacroTimingMode)}
              options={TIMING_MODE_OPTIONS}
              aria-label="Playback timing mode"
              data-testid="macro-playback-timing"
            />
          </Field>
          <Field label="Target" htmlFor="macro-playback-target">
            <Select
              value={target.value}
              onChange={setTargetValue}
              options={targets.map((t) => ({ value: t.value, label: t.label }))}
              aria-label="Playback target"
              data-testid="macro-playback-target"
            />
          </Field>
          {isMulti && targetCount === 0 && (
            <p className="macro-playback-dialog__hint" role="status">
              No connected terminals in this target.
            </p>
          )}
          {selected && selected.steps.length === 0 && (
            <p className="macro-playback-dialog__hint" role="status">
              This macro has no recorded steps.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
