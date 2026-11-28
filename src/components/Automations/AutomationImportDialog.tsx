import { useEffect, useState } from "react";
import { Ban, Check, TriangleAlert } from "lucide-react";
import { Button, Modal } from "@/components/ui";
import {
  describeLeftOut,
  type AutomationImport,
  type ImportedEntry,
} from "@/services/automationFileIo";
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

/** What to know about one imported automation, a sentence each. */
function entryNotes(entry: ImportedEntry): string[] {
  const notes: string[] = [];
  if (entry.leftOut.length > 0) {
    notes.push(
      `Left out ${describeLeftOut(entry.leftOut)}. It may do less, or something else, than the ` +
        "original: check it before you run it. Its row says so until you have saved it."
    );
  }
  if (entry.triggersOff.length > 0) {
    notes.push(`Triggers off: ${entry.triggersOff.join(", ")}. Turn them on in its row.`);
  }
  if (entry.localProcess) {
    notes.push(
      `Runs a program on this computer: not until you turn on ${EXPERIMENTAL_SETTING_PATH} and allow the program.`
    );
  }
  for (const path of entry.removedScriptPaths) {
    notes.push(
      `Read its script from ${path}: the path was removed, the script text in the step is used.`
    );
  }
  for (const runs of entry.outside) {
    notes.push(
      runs === null
        ? "Runs an automation that is not in the file: choose one in its step, or that step fails."
        : `Runs “${runs}” of your library: it is not in the file.`
    );
  }
  return notes;
}

/**
 * What an import of automations brought in (#5818, slice 11): how many of how
 * many, and for each what was imported, left out, switched off or refused.
 */
export function AutomationImportDialog({ result, onClose, onShow }: AutomationImportDialogProps) {
  // Keep the text while the dialog fades out.
  const [shown, setShown] = useState(result);
  useEffect(() => {
    if (result) setShown(result);
  }, [result]);
  const current = result ?? shown;
  const entries = current?.entries ?? [];
  const refused = current?.refused ?? [];
  const count = entries.length;
  const total = count + refused.length;
  const title =
    count === 0
      ? "Nothing was imported"
      : refused.length > 0
        ? `Imported ${count} of ${total} automations`
        : `Imported ${count} automation${count === 1 ? "" : "s"}`;

  return (
    <Modal
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      size="md"
      data-testid="automation-import-dialog"
      footer={
        count === 0 ? (
          <Button variant="primary" onClick={onClose} data-testid="automation-import-close">
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} data-testid="automation-import-close">
              Close
            </Button>
            <Button variant="primary" onClick={onShow} data-testid="automation-import-show">
              Show in sidebar
            </Button>
          </>
        )
      }
    >
      {total === 0 ? (
        <p data-testid="automation-import-names">The file holds no automations.</p>
      ) : (
        // One block per automation, what came in first (A-051).
        <ul className="automation-import" data-testid="automation-import-names">
          {entries.map((entry) => {
            const notes = entryNotes(entry);
            const partly = entry.leftOut.length > 0;
            return (
              <li
                key={entry.automation.id}
                className="automation-import__entry"
                data-testid={`automation-import-entry-${entry.automation.name}`}
                data-state={partly ? "partly" : "imported"}
              >
                {partly ? (
                  <TriangleAlert size={14} aria-hidden="true" />
                ) : (
                  <Check size={14} aria-hidden="true" />
                )}
                <div>
                  <p>
                    <strong>{entry.automation.name}</strong>:{" "}
                    {partly ? "imported in part" : "imported"}
                    {entry.renamedFrom !== undefined &&
                      ` as a copy, because “${entry.renamedFrom}” is already in your library`}
                  </p>
                  {notes.length > 0 && (
                    <ul className="automation-import__notes">
                      {notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
          {refused.map(({ name, kind }, i) => (
            <li
              key={`refused-${i}`}
              className="automation-import__entry"
              data-testid={`automation-import-refused-${name}`}
              data-state="refused"
            >
              <Ban size={14} aria-hidden="true" />
              <div>
                <p>
                  <strong>{name}</strong>: not imported
                </p>
                <ul className="automation-import__notes">
                  <li>
                    It needs a newer termiHub ({kind}). Update termiHub, then import the file again.
                    {count > 0 && " What came in now is then there twice: delete the copies."}
                  </li>
                </ul>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
