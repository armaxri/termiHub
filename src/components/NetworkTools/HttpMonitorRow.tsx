import { Play, Pause, StopCircle, Trash2, LineChart } from "lucide-react";
import { Button } from "@/components/ui";
import type { HttpMonitorState } from "@/types/network";
import { monitorServiceState, serviceStateLabel } from "@/utils/serviceState";
import "@/components/ServiceListItem/ServiceListItem.css";
import type { MonitorNextStep, MonitorRunActions } from "./monitorRow";

interface HttpMonitorRowProps {
  monitor: HttpMonitorState;
  /** The machine it runs on, by name; `undefined` for this computer (#6039). */
  runsOn?: string;
  /** What can be run now (F-009). */
  runs: MonitorRunActions;
  /** What helps with its reason (F-009). */
  nextSteps: MonitorNextStep[];
  onNextStep: (step: MonitorNextStep["id"], id: string) => void;
  onShow: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onStop: (id: string) => void;
  onRemove: (id: string) => void;
}

/**
 * One row of the HTTP monitor panel's monitor list, in the words of a Services
 * row (F-009): the URL and the state word, how and where it checks, why it does
 * not with the next step, and the actions that can be done now, labelled, on a
 * line of their own.
 */
export function HttpMonitorRow({
  monitor: m,
  runsOn,
  runs,
  nextSteps,
  onNextStep,
  onShow,
  onPause,
  onResume,
  onStop,
  onRemove,
}: HttpMonitorRowProps) {
  const id = m.config.id;
  const state = monitorServiceState(m);
  const word = m.paused && state === "running" ? "Paused" : serviceStateLabel(state);
  return (
    <div className="http-monitor-row" data-testid={`monitor-row-${id}`}>
      <div className="http-monitor-row__head">
        <span className="http-monitor-row__url" title={m.config.url}>
          {m.config.url}
        </span>
        <span
          className="http-monitor-row__state"
          data-state={state}
          data-testid={`monitor-state-${id}`}
        >
          {word}
        </span>
      </div>
      <span className="http-monitor-row__meta">
        {m.config.method} · every {m.config.intervalMs / 1000}s{runsOn ? ` · on ${runsOn}` : ""}
      </span>
      {(m.reason || nextSteps.length > 0) && (
        <span className="http-monitor-row__reason" data-state={state}>
          <span data-testid={`monitor-reason-${id}`}>{m.reason}</span>
          {nextSteps.map((step) => (
            <span key={step.id}>
              {" "}
              <button
                type="button"
                className="service-row__next"
                onClick={() => onNextStep(step.id, id)}
                data-testid={`monitor-step-${step.id}-${id}`}
              >
                {step.label}
              </button>
            </span>
          ))}
        </span>
      )}
      <div className="http-monitor-row__actions" data-testid={`monitor-actions-${id}`}>
        <Button
          variant="ghost"
          size="sm"
          icon={<LineChart size={13} />}
          onClick={() => onShow(id)}
          aria-label={`Show checks for ${m.config.url}`}
          data-testid={`monitor-show-${id}`}
        >
          Show checks
        </Button>
        {runs.pause && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Pause size={13} />}
            onClick={() => onPause(id)}
            aria-label={`Pause monitoring ${m.config.url}`}
          >
            Pause
          </Button>
        )}
        {runs.resume && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Play size={13} />}
            onClick={() => onResume(id)}
            aria-label={`Resume monitoring ${m.config.url}`}
            data-testid={`monitor-resume-${id}`}
          >
            {m.paused ? "Resume" : "Start"}
          </Button>
        )}
        {runs.stop && (
          <Button
            variant="ghost"
            size="sm"
            icon={<StopCircle size={13} />}
            onClick={() => onStop(id)}
            aria-label={`Stop monitoring ${m.config.url}`}
          >
            Stop
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={13} />}
          onClick={() => onRemove(id)}
          aria-label={`Delete monitor ${m.config.url}`}
          data-testid={`monitor-remove-${id}`}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}
