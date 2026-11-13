import { Check, Timer } from "lucide-react";
import {
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "@/components/ui";
import { DEFAULT_MONITORING_INTERVAL_MS, MONITORING_INTERVAL_OPTIONS } from "@/types/monitoring";

/** Format a refresh interval (ms) as a spaced label like "2 s" (#5628). */
export function formatRefreshInterval(ms: number): string {
  return `${ms / 1000} s`;
}

/** Props for {@link MonitoringRefreshSubmenu}. */
export interface MonitoringRefreshSubmenuProps {
  /** Current refresh interval in ms. */
  intervalMs: number;
  /** Whether a monitor is resolvable (the options are disabled otherwise). */
  enabled: boolean;
  /** Change the refresh interval. */
  onSetInterval: (intervalMs: number) => void | Promise<void>;
}

/**
 * The host menu's refresh interval as one `Refresh: 2 s ▸` row (#5628): the
 * options (`1 s`, `2 s (default)`, …) live in a submenu instead of four rows
 * under a heading, which kept the host menu from fitting an 800×600 window.
 */
export function MonitoringRefreshSubmenu({
  intervalMs,
  enabled,
  onSetInterval,
}: MonitoringRefreshSubmenuProps) {
  return (
    <MenuSub>
      <MenuSubTrigger
        icon={<Timer size={14} />}
        disabled={!enabled}
        data-testid="monitoring-refresh-trigger"
      >
        Refresh: {formatRefreshInterval(intervalMs)}
      </MenuSubTrigger>
      <MenuSubContent sideOffset={4} data-testid="monitoring-refresh-menu">
        <MenuRadioGroup value={String(intervalMs)} onValueChange={(v) => onSetInterval(Number(v))}>
          {MONITORING_INTERVAL_OPTIONS.map((opt) => (
            <MenuRadioItem
              key={opt}
              className="monitoring-menu__radio"
              value={String(opt)}
              data-testid={`monitoring-interval-${opt}`}
            >
              <MenuItemIndicator className="monitoring-menu__radio-indicator">
                <Check size={14} />
              </MenuItemIndicator>
              <span className="monitoring-menu__radio-label">
                {formatRefreshInterval(opt)}
                {opt === DEFAULT_MONITORING_INTERVAL_MS && " (default)"}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubContent>
    </MenuSub>
  );
}
