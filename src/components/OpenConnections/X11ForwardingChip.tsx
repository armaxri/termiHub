import { AlertTriangle, MonitorCog, MonitorX } from "lucide-react";
import { Chip } from "@/components/ui";
import type { X11ForwardingMode } from "@/types/generated/X11ForwardingMode";

/** What the chip shows for one {@link X11ForwardingMode}. */
interface X11ModeCopy {
  label: string;
  hint: string;
  tone: "ok" | "fallback" | "failed";
}

/**
 * The chip label and its hover/focus hint for each mode (#5586). The label
 * stays short so the row does not grow; the hint says why and what to do.
 */
export function x11ModeCopy(mode: X11ForwardingMode): X11ModeCopy {
  switch (mode) {
    case "serverForwarded":
      return {
        label: "X11",
        hint: "X11 forwarding: the SSH server sets DISPLAY. Nothing is typed into the shell.",
        tone: "ok",
      };
    case "fallbackRefused":
      return {
        label: "X11 fallback",
        hint:
          "The server refused X11 forwarding (X11Forwarding no), so DISPLAY is set by a " +
          "hidden setup typed into the shell. Set X11Forwarding yes in the server's " +
          "sshd_config to let the server forward X11.",
        tone: "fallback",
      };
    case "fallbackNoReply":
      return {
        label: "X11 fallback",
        hint:
          "The server did not answer the X11 forwarding request, so DISPLAY is set by a " +
          "hidden setup typed into the shell.",
        tone: "fallback",
      };
    case "failed":
      return {
        label: "X11 failed",
        hint:
          "X11 forwarding could not be set up, so this session runs without it. Start a " +
          "local X server (XQuartz on macOS) and reconnect.",
        tone: "failed",
      };
  }
}

const ICONS = {
  ok: <MonitorCog size={12} />,
  fallback: <AlertTriangle size={12} />,
  failed: <MonitorX size={12} />,
} as const;

/** Props for {@link X11ForwardingChip}. */
export interface X11ForwardingChipProps {
  /** The session's X11 forwarding mode. */
  mode: X11ForwardingMode;
  /** Test hook on the chip. */
  "data-testid"?: string;
}

/**
 * A small chip on an SSH session's Open Connections row saying how its X11
 * forwarding runs (#5586): forwarded by the server, the typed fallback, or
 * failed. The why and the fix are in its tooltip, so the row stays quiet.
 */
export function X11ForwardingChip({ mode, "data-testid": testId }: X11ForwardingChipProps) {
  const copy = x11ModeCopy(mode);
  return (
    <span className={`oc-x11 oc-x11--${copy.tone}`} data-x11-mode={mode}>
      <Chip label={copy.label} icon={ICONS[copy.tone]} tooltip={copy.hint} data-testid={testId} />
    </span>
  );
}
