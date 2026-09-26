import { Play, Pause, StopCircle, Trash2, LineChart } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import type { HttpMonitorState } from "@/types/network";

interface HttpMonitorRowProps {
  monitor: HttpMonitorState;
  /** The hosting agent's id, or `undefined` when it runs on this computer. */
  agentId?: string;
  onShow: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onStop: (id: string) => void;
  onRemove: (id: string) => void;
}

/**
 * One row of the HTTP monitor panel's monitor list: URL, cadence, where it
 * runs, its lifecycle state, and the per-monitor actions (show checks, pause,
 * resume, stop, remove).
 */
export function HttpMonitorRow({
  monitor: m,
  agentId,
  onShow,
  onPause,
  onResume,
  onStop,
  onRemove,
}: HttpMonitorRowProps) {
  const id = m.config.id;
  return (
    <div className="http-monitor-row" data-testid={`monitor-row-${id}`}>
      <span className="http-monitor-row__url" title={m.config.url}>
        {m.config.url}
      </span>
      <span className="http-monitor-row__meta">
        {m.config.method} · every {m.config.intervalMs / 1000}s{agentId ? ` · on ${agentId}` : ""}
        {!m.running ? " · stopped" : m.paused ? " · paused" : ""}
      </span>
      {m.running && !m.paused && (
        <Tooltip content="Pause" side="left">
          <Button
            variant="ghost"
            size="sm"
            icon={<Pause size={13} />}
            onClick={() => onPause(id)}
            aria-label={`Pause monitoring ${m.config.url}`}
          />
        </Tooltip>
      )}
      <Tooltip content="Show checks" side="left">
        <Button
          variant="ghost"
          size="sm"
          icon={<LineChart size={13} />}
          onClick={() => onShow(id)}
          aria-label={`Show checks for ${m.config.url}`}
          data-testid={`monitor-show-${id}`}
        />
      </Tooltip>
      {(m.paused || !m.running) && (
        <Tooltip content="Resume" side="left">
          <Button
            variant="ghost"
            size="sm"
            icon={<Play size={13} />}
            onClick={() => onResume(id)}
            aria-label={`Resume monitoring ${m.config.url}`}
          />
        </Tooltip>
      )}
      {m.running && (
        <Tooltip content="Stop" side="left">
          <Button
            variant="ghost"
            size="sm"
            icon={<StopCircle size={13} />}
            onClick={() => onStop(id)}
            aria-label={`Stop monitoring ${m.config.url}`}
          />
        </Tooltip>
      )}
      <Tooltip content="Remove" side="left">
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={13} />}
          onClick={() => onRemove(id)}
          aria-label={`Remove monitor ${m.config.url}`}
        />
      </Tooltip>
    </div>
  );
}
