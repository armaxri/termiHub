import { useCallback, useState } from "react";
import { FileText, ShieldCheck, ShieldAlert } from "lucide-react";
import { Button, toast } from "@/components/ui";
import { open as openFileDialog } from "@/services/nativeDialog";
import { localReadFile } from "@/services/api";
import {
  isScriptSourceConfirmed,
  withConfirmedScriptSource,
} from "@/services/workflowScriptSources";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { errorMessage } from "@/utils/errorMessage";

interface ScriptSourceFieldProps {
  /** Unique id/testid suffix for this step's fields. */
  fieldId: string;
  /** 1-based number used in aria labels ("step N"). */
  stepNumber: number;
  /** The step's current on-disk script path, if any. */
  sourcePath: string | undefined;
  /** The user picked `path`; `contents` is the file's text at pick time. */
  onPick: (path: string, contents: string) => void;
  /** The user detached the file: the step runs its visible script again. */
  onDetach: () => void;
}

/**
 * The "script file" control of a `run-script` step (#4310, FEC2-001).
 *
 * A file-backed step reads its body from disk on every run and types it into
 * the target session, so the real path is always shown, never hidden. The
 * runner reads it only when the user picked it here or confirmed it on this
 * machine — an imported or otherwise unconfirmed path is flagged and must be
 * confirmed or re-picked before the step will run. Picking and confirming both
 * add the exact path to the machine-local `workflowScriptSourceAllowlist`
 * setting, which no workflow file can write.
 */
export function ScriptSourceField({
  fieldId,
  stepNumber,
  sourcePath,
  onPick,
  onDetach,
}: ScriptSourceFieldProps) {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [busy, setBusy] = useState(false);
  const confirmed =
    sourcePath !== undefined &&
    isScriptSourceConfirmed(settings.workflowScriptSourceAllowlist, sourcePath);

  const trustPath = useCallback(
    async (path: string) => {
      await updateSettings({
        ...settings,
        workflowScriptSourceAllowlist: withConfirmedScriptSource(
          settings.workflowScriptSourceAllowlist,
          path
        ),
      });
    },
    [settings, updateSettings]
  );

  const handlePick = useCallback(async () => {
    setBusy(true);
    try {
      const selected = await openFileDialog({ multiple: false, directory: false });
      if (typeof selected !== "string") return;
      const contents = await localReadFile(selected);
      await trustPath(selected);
      onPick(selected, contents);
    } catch (err) {
      toast.error("Could not load the script file", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [onPick, trustPath]);

  const handleConfirm = useCallback(async () => {
    if (sourcePath === undefined) return;
    setBusy(true);
    try {
      await trustPath(sourcePath);
    } catch (err) {
      toast.error("Could not confirm the script file", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [sourcePath, trustPath]);

  return (
    <div className="workflow-step__source" data-testid={`workflow-editor-step-source-${fieldId}`}>
      {sourcePath !== undefined && (
        <>
          <div className="workflow-step__source-path">
            <FileText size={12} aria-hidden="true" />
            <code data-testid={`workflow-editor-step-source-path-${fieldId}`}>{sourcePath}</code>
          </div>
          <p
            className={
              confirmed
                ? "workflow-step__source-status"
                : "workflow-step__source-status workflow-step__source-status--untrusted"
            }
            role={confirmed ? undefined : "alert"}
            data-testid={`workflow-editor-step-source-status-${fieldId}`}
          >
            {confirmed ? (
              <>
                <ShieldCheck size={12} aria-hidden="true" /> Read from this file on every run.
                Editing the script below detaches the file.
              </>
            ) : (
              <>
                <ShieldAlert size={12} aria-hidden="true" /> Not confirmed on this machine. This
                step will not read the file or run until you confirm or re-pick it.
              </>
            )}
          </p>
        </>
      )}
      <div className="workflow-step__source-actions">
        {sourcePath !== undefined && !confirmed && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void handleConfirm()}
            aria-label={`Confirm script file for step ${stepNumber}`}
            data-testid={`workflow-editor-step-source-confirm-${fieldId}`}
          >
            Confirm file
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void handlePick()}
          aria-label={`Choose script file for step ${stepNumber}`}
          data-testid={`workflow-editor-step-source-pick-${fieldId}`}
        >
          {sourcePath !== undefined ? "Choose another file…" : "Load from file…"}
        </Button>
        {sourcePath !== undefined && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onDetach}
            aria-label={`Detach script file from step ${stepNumber}`}
            data-testid={`workflow-editor-step-source-detach-${fieldId}`}
          >
            Detach file
          </Button>
        )}
      </div>
    </div>
  );
}
