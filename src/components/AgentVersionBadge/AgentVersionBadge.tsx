import { CheckCircle2, ArrowUpCircle, AlertTriangle, Loader2 } from "lucide-react";
import type { AgentUpdateState } from "@/utils/agentVersion";
import "./AgentVersionBadge.css";

/** Per-state icon, short label, and accessible description (version interpolated). */
const STATE_META: Record<
  Exclude<AgentUpdateState, "unknown">,
  {
    Icon: typeof CheckCircle2;
    label: string;
    describe: (version: string) => string;
  }
> = {
  "up-to-date": {
    Icon: CheckCircle2,
    label: "Up to date",
    describe: (v) => `Agent up to date (v${v})`,
  },
  "update-available": {
    Icon: ArrowUpCircle,
    label: "Update available",
    describe: (v) => `Update available — agent v${v}, a newer version can be deployed`,
  },
  incompatible: {
    Icon: AlertTriangle,
    label: "Incompatible",
    describe: (v) => `Incompatible agent version (v${v}) — reinstall required`,
  },
  updating: {
    Icon: Loader2,
    label: "Updating…",
    describe: () => "Updating agent…",
  },
};

/** Props for {@link AgentVersionBadge}. */
export interface AgentVersionBadgeProps {
  /** Agent binary version string, e.g. `0.1.0`. */
  version?: string;
  /** Derived update state controlling the badge icon/colour. */
  state: AgentUpdateState;
  /** Render the state word next to the icon (used where horizontal room exists). */
  showLabel?: boolean;
  "data-testid"?: string;
}

/**
 * Compact version chip + update-state badge for a remote agent.
 *
 * Shown in the sidebar agent header, the Open Connections modal, and (in
 * summary form) the status bar. Renders nothing when the version is unknown
 * (agent disconnected / no version reported), so callers can mount it
 * unconditionally.
 */
export function AgentVersionBadge({
  version,
  state,
  showLabel = false,
  "data-testid": testId,
}: AgentVersionBadgeProps) {
  if (state === "unknown" || !version) return null;

  const meta = STATE_META[state];
  const description = meta.describe(version);

  return (
    <span className="agent-version-badge" data-testid={testId}>
      <span className="agent-version-badge__chip" title={`Agent binary version v${version}`}>
        v{version}
      </span>
      <span
        className={`agent-version-badge__state agent-version-badge__state--${state}`}
        role="status"
        aria-label={description}
        title={description}
      >
        <meta.Icon
          className={
            state === "updating"
              ? "agent-version-badge__icon motion-essential-spinner"
              : "agent-version-badge__icon"
          }
          aria-hidden="true"
        />
        {showLabel && <span className="agent-version-badge__label">{meta.label}</span>}
      </span>
    </span>
  );
}
