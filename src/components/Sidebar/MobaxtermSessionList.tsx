import { AlertTriangle, Ban } from "lucide-react";
import { Checkbox } from "@/components/ui";
import type { MobaxtermSession } from "@/types/connection";
import { folderLabel } from "@/services/mobaxtermImport";

interface MobaxtermSessionListProps {
  /** Sessions that can be imported. */
  importable: MobaxtermSession[];
  /** Sessions that cannot be imported, each with its `skipReason`. */
  skipped: MobaxtermSession[];
  /** Keys of the selected importable sessions. */
  selected: Set<string>;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
}

/** `SSH · admin@10.0.0.1 · Lab / Switches`, leaving out empty parts. */
function metaLine(session: MobaxtermSession): string {
  return [session.sessionType, session.target, folderLabel(session.folderPath)]
    .filter((part) => part.length > 0)
    .join(" · ");
}

/**
 * The preview list of the MobaXterm import (#4850): every importable session
 * with a checkbox, its type, target and MobaXterm folder, plus any notes on
 * settings that were not carried over; then the skipped sessions with the
 * reason each one cannot be imported.
 */
export function MobaxtermSessionList({
  importable,
  skipped,
  selected,
  onToggle,
  onToggleAll,
}: MobaxtermSessionListProps) {
  const allSelected = importable.length > 0 && selected.size === importable.length;
  const someSelected = selected.size > 0 && !allSelected;

  return (
    <div className="mobaxterm-import__lists">
      {importable.length > 0 && (
        <>
          <div className="bulk-ssh-import__selectall">
            <Checkbox
              checked={allSelected ? true : someSelected ? "indeterminate" : false}
              onCheckedChange={onToggleAll}
              aria-label="Select all sessions"
              data-testid="mobaxterm-import-select-all"
            />
            <span className="bulk-ssh-import__selectall-label">
              {selected.size} of {importable.length} selected
            </span>
          </div>
          <ul className="ssh-config-import__list" data-testid="mobaxterm-import-list">
            {importable.map((session) => (
              <li key={session.key}>
                <label
                  className="bulk-ssh-import__row"
                  data-testid={`mobaxterm-import-row-${session.key}`}
                >
                  <Checkbox
                    checked={selected.has(session.key)}
                    onCheckedChange={() => onToggle(session.key)}
                    aria-label={`Select ${session.name}`}
                    data-testid={`mobaxterm-import-check-${session.key}`}
                  />
                  <span className="ssh-config-import__row-text">
                    <span className="ssh-config-import__row-name">{session.name}</span>
                    <span className="ssh-config-import__row-chain">{metaLine(session)}</span>
                    {session.notes.map((note) => (
                      <span key={note} className="mobaxterm-import__note">
                        <AlertTriangle size={12} aria-hidden />
                        {note}
                      </span>
                    ))}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      {skipped.length > 0 && (
        <section className="mobaxterm-import__skipped" data-testid="mobaxterm-import-skipped">
          <h3 className="mobaxterm-import__skipped-title">Not imported ({skipped.length})</h3>
          <ul className="ssh-config-import__list">
            {skipped.map((session) => (
              <li
                key={session.key}
                className="mobaxterm-import__skipped-row"
                data-testid={`mobaxterm-import-skip-${session.key}`}
              >
                <Ban size={14} aria-hidden className="mobaxterm-import__skipped-icon" />
                <span className="ssh-config-import__row-text">
                  <span className="ssh-config-import__row-name">{session.name}</span>
                  <span className="ssh-config-import__row-chain">{metaLine(session)}</span>
                  <span className="mobaxterm-import__reason">{session.skipReason}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
