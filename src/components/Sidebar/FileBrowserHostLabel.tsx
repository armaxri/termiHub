import { Monitor, Server } from "lucide-react";
import type { FileBrowserHost } from "@/utils/fileBrowserHost";
import "./FileBrowserHostLabel.css";

/** Props for {@link FileBrowserHostLabel}. */
export interface FileBrowserHostLabelProps {
  /** Whose filesystem is browsed; nothing renders when it is unknown. */
  host: FileBrowserHost | null;
}

/**
 * The file browser's "whose filesystem is this" line (#5623): a distinct icon
 * for this computer vs. a remote host, plus the host's name. The label
 * ellipsizes at narrow widths and carries the full name as its tooltip.
 */
export function FileBrowserHostLabel({ host }: FileBrowserHostLabelProps) {
  if (!host) return null;
  const Icon = host.kind === "local" ? Monitor : Server;
  return (
    <div
      className={`file-browser-host file-browser-host--${host.kind}`}
      data-testid="file-browser-host"
      data-host-kind={host.kind}
      title={host.label}
    >
      <Icon size={12} className="file-browser-host__icon" aria-hidden="true" />
      <span className="file-browser-host__label">{host.label}</span>
    </div>
  );
}
