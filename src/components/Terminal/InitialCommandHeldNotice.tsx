import { useRef } from "react";
import { Hourglass } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, toast } from "@/components/ui";
import { sendHeldInitialCommand } from "@/services/api";
import {
  clearInitialCommandHeld,
  dismissInitialCommandHeld,
  useInitialCommandHeldNotice,
  type InitialCommandHeldNotice as HeldNotice,
} from "@/store/initialCommandHeldBridge";
import "./InitialCommandHeldNotice.css";

interface InitialCommandHeldNoticeProps {
  tabId: string;
}

/** The notice's words for what is held: the setup, the command, or both. */
export function heldNoticeCopy({
  setup,
  initialCommand,
}: Pick<HeldNotice, "setup" | "initialCommand">): {
  text: string;
  label: string;
  sent: string;
  already: string;
} {
  if (setup && initialCommand) {
    return {
      text: "Waiting for the shell prompt — command marks and initial command not sent yet",
      label: "Command marks and initial command not sent",
      sent: "Command marks set up and initial command sent",
      already: "The initial command was already sent",
    };
  }
  if (setup) {
    return {
      text: "Waiting for the shell prompt — command marks not set up yet",
      label: "Command marks not set up",
      sent: "Command marks set up",
      already: "Command marks were already set up",
    };
  }
  return {
    text: "Waiting for the shell prompt — initial command not sent yet",
    label: "Initial command not sent",
    sent: "Initial command sent",
    already: "The initial command was already sent",
  };
}

/**
 * The "initial command not sent yet" notice of a terminal tab (#5509).
 *
 * A local bash / zsh from 5.1 gets its initial command only once its line
 * editor announces the prompt, so it is never typed into a startup question.
 * A shell with bracketed paste turned off never announces it; after the wait
 * the backend reports the command held and this notice offers **Send now**
 * (types it once, at the user's word) or a dismiss. Nothing is sent on its
 * own, and the notice goes away by itself when the prompt comes after all.
 *
 * With command marks on, the shell-integration setup waits for the same
 * prompt, and the initial command behind it (#5512): the notice then covers
 * the setup, and Send now types the setup, then the command.
 */
export function InitialCommandHeldNotice({ tabId }: InitialCommandHeldNoticeProps) {
  const sessionId = useAppStore((s) => s.tabContent[tabId]?.sessionId ?? null);
  const notice = useInitialCommandHeldNotice(sessionId);
  // One send per session's held command, even for a double click before the
  // re-render; a reconnect's new session gets its own.
  const sending = useRef<string | null>(null);

  if (!notice || !sessionId) return null;
  const copy = heldNoticeCopy(notice);

  const handleSendNow = async () => {
    if (sending.current === sessionId) return;
    sending.current = sessionId;
    let sent: boolean;
    try {
      sent = await sendHeldInitialCommand(sessionId);
    } catch (err) {
      sending.current = null;
      throw err;
    }
    clearInitialCommandHeld(sessionId);
    if (sent) toast.success(copy.sent);
    else toast.info(copy.already);
  };

  return (
    <div
      className="initial-command-held-notice"
      role="status"
      aria-label={copy.label}
      data-testid="initial-command-held-notice"
    >
      <Hourglass size={16} className="initial-command-held-notice__icon" aria-hidden />
      <span className="initial-command-held-notice__text">{copy.text}</span>
      <div className="initial-command-held-notice__actions">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSendNow}
          data-testid="initial-command-held-send-btn"
        >
          Send now
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dismissInitialCommandHeld(sessionId)}
          data-testid="initial-command-held-dismiss-btn"
        >
          Hide
        </Button>
      </div>
    </div>
  );
}
