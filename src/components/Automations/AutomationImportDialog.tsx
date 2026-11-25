import { useEffect, useState } from "react";
import { Ban, FileX2, Link2Off, Scissors, SquareTerminal, ZapOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button, Modal } from "@/components/ui";
import type { AutomationImport } from "@/services/automationFileIo";
import { EXPERIMENTAL_SETTING_PATH } from "@/utils/experimentalSetting";
import "./AutomationImportDialog.css";

/** Props for {@link AutomationImportDialog}. */
export interface AutomationImportDialogProps {
  /** What was imported; `null` closes the dialog. */
  result: AutomationImport | null;
  onClose: () => void;
  /** Show the imported automations in their list. */
  onShow: () => void;
}

/** One thing to know about the import. */
interface Note {
  id: string;
  Icon: LucideIcon;
  /** What it is about, as a full sentence. */
  text: string;
  /** Which automations, one line each. */
  lines: string[];
}

/** The notes an import needs; empty when there is nothing to look at. */
function importNotes(result: AutomationImport): Note[] {
  const notes: Note[] = [];
  if (result.refused.length > 0) {
    notes.push({
      id: "refused",
      Icon: Ban,
      text: "Not imported: they have a step or a trigger this version of termiHub does not know. Update termiHub to import them.",
      lines: result.refused.map(({ name, kind }) => `${name}: ${kind}`),
    });
  }
  if (result.leftOut.length > 0) {
    notes.push({
      id: "left-out",
      Icon: Scissors,
      text: "Parts this version of termiHub does not know were left out. Check what they do before you run them.",
      lines: result.leftOut,
    });
  }
  if (result.disarmed.length > 0) {
    notes.push({
      id: "disarmed",
      Icon: ZapOff,
      text: "Switched off. Their triggers and hotkeys do nothing until you turn them on in the list.",
      lines: result.disarmed,
    });
  }
  if (result.localProcess.length > 0) {
    notes.push({
      id: "local-process",
      Icon: SquareTerminal,
      text: `Run programs on this computer. They do not run until you turn on ${EXPERIMENTAL_SETTING_PATH} and allow the program.`,
      lines: result.localProcess,
    });
  }
  if (result.removedScriptPaths.length > 0) {
    notes.push({
      id: "script-paths",
      Icon: FileX2,
      text: "Read a script from a file. The path was removed, so the script text in the step is used. Choose the file again in the step to read it.",
      lines: result.removedScriptPaths.map(({ name, path }) => `${name}: ${path}`),
    });
  }
  if (result.outside.length > 0) {
    notes.push({
      id: "outside",
      Icon: Link2Off,
      text: "Run an automation that is not in the file.",
      lines: result.outside.map(({ name, runs }) =>
        runs === null
          ? `${name}: choose one in its “Run automation” step, or that step fails`
          : `${name}: runs “${runs}” of your library`
      ),
    });
  }
  return notes;
}

/**
 * What an import of automations brought in (#5818, slice 11): how many, which
 * were switched off, and what else needs a look before one is run.
 */
export function AutomationImportDialog({ result, onClose, onShow }: AutomationImportDialogProps) {
  // Keep the text while the dialog fades out.
  const [shown, setShown] = useState(result);
  useEffect(() => {
    if (result) setShown(result);
  }, [result]);
  const current = result ?? shown;
  const count = current?.automations.length ?? 0;
  const notes = current ? importNotes(current) : [];

  return (
    <Modal
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        count === 0
          ? "Nothing was imported"
          : `Imported ${count} automation${count === 1 ? "" : "s"}`
      }
      size="md"
      data-testid="automation-import-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onShow} data-testid="automation-import-show">
            Show in sidebar
          </Button>
          <Button variant="primary" onClick={onClose} data-testid="automation-import-close">
            Close
          </Button>
        </>
      }
    >
      <div className="automation-import">
        {(count > 0 || notes.length === 0) && (
          <p data-testid="automation-import-names">
            {count === 0
              ? "The file holds no automations."
              : (current?.automations ?? []).map((a) => a.name).join(", ")}
          </p>
        )}
        {notes.length > 0 && (
          <ul className="automation-import__notes">
            {notes.map(({ id, Icon, text, lines }) => (
              <li
                key={id}
                className="automation-import__note"
                data-testid={`automation-import-note-${id}`}
              >
                <Icon size={14} aria-hidden="true" />
                <div>
                  <p>{text}</p>
                  <ul className="automation-import__lines">
                    {lines.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
