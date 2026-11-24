import { WifiOff, CheckCircle2, Unplug, SquareTerminal, Usb } from "lucide-react";
import type { SessionEndKind } from "./dropCopy";

/**
 * The icon per kind of session end (#5910), shared by the session-end strip
 * and the view-mode banner so both show the same one (#5955): only a dropped
 * link shows WifiOff, a process exit shows a terminal.
 */
export const SESSION_END_ICONS: Record<SessionEndKind, typeof WifiOff> = {
  exited: SquareTerminal,
  ended: CheckCircle2,
  user: Unplug,
  device: Usb,
  link: WifiOff,
};
