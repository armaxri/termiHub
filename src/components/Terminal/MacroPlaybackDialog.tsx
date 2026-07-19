import { useEffect, useMemo, useState } from "react";
import { Modal, Button, Field, Select } from "@/components/ui";
import type { Macro } from "@/types/macro";
import type { MacroTimingMode } from "@/services/macroPlayback";
import "./MacroPlaybackDialog.css";

export interface MacroPlaybackDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The stored macros available to play. */
  macros: Macro[];
  /** Called when the dialog should open/close. */
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen macro id and timing mode when the user hits Play. */
  onPlay: (macroId: string, timingMode: MacroTimingMode) => void;
}

/** Human-readable labels for each timing mode, shown in the mode picker. */
const TIMING_MODE_OPTIONS: { value: MacroTimingMode; label: string }[] = [
  { value: "real-time", label: "Real-time (recorded delays)" },
  { value: "fixed", label: "Fixed delay per step" },
  { value: "instant", label: "Instant (no delay)" },
];

/**
 * Picker shown from the terminal toolbar's "Play Macro" action: choose a stored
 * macro and a timing mode, then replay it into the active terminal. Composed
 * from the shared UI primitives. When no macros exist the dialog explains how to
 * record one rather than presenting an empty, un-actionable list.
 */
export function MacroPlaybackDialog({
  open,
  macros,
  onOpenChange,
  onPlay,
}: MacroPlaybackDialogProps) {
  const [macroId, setMacroId] = useState<string | undefined>(undefined);
  const [timingMode, setTimingMode] = useState<MacroTimingMode>("real-time");

  // Default the selection to the first macro each time the dialog opens so Play
  // is immediately actionable; reset the mode to the sensible default.
  useEffect(() => {
    if (open) {
      setMacroId(macros[0]?.id);
      setTimingMode("real-time");
    }
  }, [open, macros]);

  const macroOptions = useMemo(
    () => macros.map((m) => ({ value: m.id, label: m.name })),
    [macros]
  );

  const selected = macros.find((m) => m.id === macroId) ?? null;
  const canPlay = selected !== null && selected.steps.length > 0;

  const handlePlay = () => {
    if (!macroId || !canPlay) return;
    onPlay(macroId, timingMode);
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Play Macro"
      description="Replay a stored macro's input into the active terminal"
      onKeyDown={(e) => {
        if (e.key === "Enter" && canPlay) handlePlay();
      }}
      data-testid="macro-playback-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="macro-playback-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handlePlay}
            disabled={!canPlay}
            data-testid="macro-playback-confirm"
          >
            Play
          </Button>
        </>
      }
    >
      {macros.length === 0 ? (
        <p className="macro-playback-dialog__empty" role="status">
          No macros saved yet. Record one with the terminal toolbar's record button first.
        </p>
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
