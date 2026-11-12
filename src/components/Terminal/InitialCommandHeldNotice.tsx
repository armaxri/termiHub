import { useRef } from "react";
import { Hourglass } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, toast } from "@/components/ui";
import { sendHeldInitialCommand } from "@/services/api";
import {
  clearInitialCommandHeld,
  dismissInitialCommandHeld,
  useInitialCommandHeldNotice,
} from "@/store/initialCommandHeldBridge";
import "./InitialCommandHeldNotice.css";

interface InitialCommandHeldNoticeProps {
  tabId: string;
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
 */
export function InitialCommandHeldNotice({ tabId }: InitialCommandHeldNoticeProps) {
  const sessionId = useAppStore((s) => s.tabContent[tabId]?.sessionId ?? null);
  const shown = useInitialCommandHeldNotice(sessionId);
  // One send per session's held command, even for a double click before the
  // re-render; a reconnect's new session gets its own.
  const sending = useRef<string | null>(null);

  if (!shown || !sessionId) return null;

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
    if (sent) toast.success("Initial command sent");
    else toast.info("The initial command was already sent");
  };

  return (
    <div
      className="initial-command-held-notice"
      role="status"
      aria-label="Initial command not sent"
      data-testid="initial-command-held-notice"
    >
      <Hourglass size={16} className="initial-command-held-notice__icon" aria-hidden />
      <span className="initial-command-held-notice__text">
        Waiting for the shell prompt — initial command not sent yet
      </span>
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
