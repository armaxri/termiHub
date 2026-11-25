import { CircleDot, KeyRound } from "lucide-react";
import { Button } from "@/components/ui";
import { t } from "@/i18n/catalog";
import { useAppStore } from "@/store/appStore";
import "./Recording.css";

/**
 * The strip above the terminals (#5818, slice 8): the way back to the automation
 * editor while a recording goes into it, and the reminder of a recording that is
 * neither saved nor discarded. A plain recording shows as the toolbar's chip.
 */
export function RecordingBar() {
  const recording = useAppStore((s) => s.recording);
  const take = useAppStore((s) => s.recordedTake);
  const saveOpen = useAppStore((s) => s.recordingSaveOpen);
  const stopRecording = useAppStore((s) => s.stopRecording);
  const setSaveOpen = useAppStore((s) => s.setRecordingSaveOpen);
  const discard = useAppStore((s) => s.discardRecordedTake);
  const cancel = useAppStore((s) => s.cancelRecording);

  if (recording && recording.intoEditor !== null) {
    const target = recording.intoEditor ? `“${recording.intoEditor}”` : "the new automation";
    return (
      <div className="recording-bar recording-bar--active" data-testid="recording-bar-editor">
        <CircleDot size={14} aria-hidden="true" />
        <span className="recording-bar__text" role="status">
          Recording into {target}: type in {recording.tabTitle}.
          {recording.atPrompt && ` ${t("recording.promptNote")}`}
        </span>
        <Button variant="ghost" size="sm" onClick={cancel} data-testid="recording-bar-cancel">
          Cancel
        </Button>
        <Button size="sm" onClick={() => stopRecording()} data-testid="recording-bar-return">
          Stop and return
        </Button>
      </div>
    );
  }

  // Said beside the Stop, not in it (B-011).
  if (recording?.atPrompt) {
    return (
      <div className="recording-bar" data-testid="recording-bar-prompt">
        <KeyRound size={14} aria-hidden="true" />
        <span className="recording-bar__text" role="status">
          {t("recording.promptNote")}
        </span>
      </div>
    );
  }

  if (!recording && take && !take.forEditor && !saveOpen) {
    return (
      <div className="recording-bar" data-testid="recording-bar-unsaved">
        <CircleDot size={14} aria-hidden="true" />
        <span className="recording-bar__text">
          The recording in {take.tabTitle} is not saved. It is lost when you close termiHub.
        </span>
        <Button variant="ghost" size="sm" onClick={discard} data-testid="recording-bar-discard">
          Discard recording
        </Button>
        <Button size="sm" onClick={() => setSaveOpen(true)} data-testid="recording-bar-save">
          Save…
        </Button>
      </div>
    );
  }
  return null;
}
