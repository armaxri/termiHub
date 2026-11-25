import { useEffect, useState } from "react";
import { Button, Checkbox, Modal } from "@/components/ui";
import { runPreview } from "@/components/Automations/runPreview";
import { useScheduleLabels } from "@/components/Schedules/useScheduleLabels";
import { dismissRestoredOff } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { Automation } from "@/types/generated/Automation";
import type { RestoredStart } from "@/types/backup";
import { errorMessage } from "@/utils/errorMessage";
import { startKey, startKind, startLines } from "@/utils/restoredStarts";
import { showExactly } from "@/utils/showExactly";
import { turnOnRestored } from "./turnOnRestored";
import "./RestoredOff.css";

export interface RestoredOffDialogProps {
  open: boolean;
  /** What the restore left switched off. */
  entries: RestoredStart[];
  /** Closed for now: the list stays. */
  onLater: () => void;
  /** Dealt with: what could not be turned on is left. */
  onDone: (left: RestoredStart[]) => void;
}

/** Every step of an automation, a line each. */
function stepLines(automation: Automation | undefined, library: readonly Automation[]): string[] {
  return (automation?.steps ?? []).flatMap((step) => runPreview({ steps: [step] }, library));
}

/**
 * What the last restore left switched off (#6056): each entry with what would start it
 * and what it does, nothing ticked, and one action that turns on what was read.
 */
export function RestoredOffDialog({ open, entries, onLater, onDone }: RestoredOffDialogProps) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<string[]>([]);
  const library = useAppStore((s) => s.automations);
  const schedules = useAppStore((s) => s.schedules);
  const labels = useScheduleLabels();

  useEffect(() => {
    setChosen(new Set());
    setErrors([]);
  }, [open]);

  const rows = entries.map((entry) => {
    const schedule =
      entry.section === "schedules" ? schedules.find((s) => s.id === entry.id) : undefined;
    const automationId = entry.section === "automations" ? entry.id : schedule?.action.automationId;
    const targets = schedule ? labels.targets(schedule.targets) : null;
    return {
      entry,
      key: startKey(entry),
      hosts: targets?.hosts ?? [],
      gone: schedule ? (labels.blockedReason(schedule) ?? null) : null,
      connects: schedule?.connectIfNeeded === true,
      steps: stepLines(
        library.find((a) => a.id === automationId),
        library
      ),
    };
  });

  const toggle = (key: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const turnOn = async () => {
    const failed: RestoredStart[] = [];
    const messages: string[] = [];
    for (const entry of entries.filter((e) => chosen.has(startKey(e)))) {
      try {
        await turnOnRestored(entry);
      } catch (err) {
        failed.push(entry);
        messages.push(`“${showExactly(entry.name)}” stays off: ${errorMessage(err)}`);
      }
    }
    if (failed.length > 0) {
      setErrors(messages);
      setChosen(new Set());
      // What was turned on is not listed any more; the rest stays to be decided.
      const on = new Set(
        entries.filter((e) => chosen.has(startKey(e)) && !failed.includes(e)).map(startKey)
      );
      onDone(entries.filter((e) => !on.has(startKey(e))));
      throw new Error(messages.join(" "));
    }
    await dismissRestoredOff();
    onDone([]);
  };

  const keepOff = async () => {
    await dismissRestoredOff();
    onDone([]);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onLater();
      }}
      title="Restored, switched off"
      data-testid="restored-off-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={keepOff} data-testid="restored-off-keep">
            Keep all off
          </Button>
          <Button
            variant="primary"
            onClick={turnOn}
            errorToast={false}
            disabled={chosen.size === 0}
            pendingLabel="Turning on…"
            data-testid="restored-off-turn-on"
          >
            {chosen.size > 1 ? `Turn on ${chosen.size}` : "Turn on selected"}
          </Button>
        </>
      }
    >
      <div className="restored-off">
        <p className="restored-off__intro">
          These would start by themselves, so the restore switched them off on this computer. Tick
          what you want to run here; the rest stays off.
        </p>
        <ul className="restored-off__list">
          {rows.map(({ entry, key, hosts, gone, connects, steps }) => (
            <li key={key} className="restored-off__row" data-testid={`restored-off-row-${key}`}>
              <Checkbox
                id={`restored-off-${key}`}
                checked={chosen.has(key)}
                onCheckedChange={(on) => toggle(key, on)}
                data-testid={`restored-off-check-${key}`}
              />
              <div className="restored-off__body">
                <label htmlFor={`restored-off-${key}`} className="restored-off__name">
                  {showExactly(entry.name)}
                  <span className="restored-off__kind">{startKind(entry)}</span>
                </label>
                <ul className="restored-off__starts">
                  {startLines(entry).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                  {gone && <li data-testid={`restored-off-gone-${key}`}>{gone}</li>}
                  {connects && <li>Connects to hosts that are not connected</li>}
                </ul>
                {(steps.length > 0 || hosts.length > 1) && (
                  <details className="restored-off__steps">
                    <summary data-testid={`restored-off-steps-${key}`}>What it does</summary>
                    {hosts.length > 1 && <p>On {hosts.map(showExactly).join(", ")}</p>}
                    <ol>
                      {steps.map((line, i) => (
                        <li key={i}>{showExactly(line)}</li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ul>
        {errors.map((message) => (
          <p
            key={message}
            className="restored-off__error"
            role="alert"
            data-testid="restored-off-error"
          >
            {message}
          </p>
        ))}
      </div>
    </Modal>
  );
}
