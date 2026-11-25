import type { RestoredStart } from "@/types/backup";
import { startKey, startKind, startLines } from "@/utils/restoredStarts";
import { showExactly } from "@/utils/showExactly";

/** More entries than this start folded. */
const OPEN_UP_TO = 3;

/** What the chosen parts would leave switched off, in the restore preview (#6056). */
export function BackupSwitchedOff({ entries }: { entries: RestoredStart[] }) {
  if (entries.length === 0) return null;
  const count = entries.length === 1 ? "1 entry starts" : `${entries.length} entries start`;
  return (
    <details
      className="backup-restore__off"
      open={entries.length <= OPEN_UP_TO}
      data-testid="backup-restore-switched-off"
    >
      <summary>
        {count} by {entries.length === 1 ? "itself" : "themselves"}: restored switched off
      </summary>
      <p className="backup-restore__detail">
        After the restart, termiHub asks which of them to turn on here.
      </p>
      <ul>
        {entries.map((entry) => (
          <li key={startKey(entry)} data-testid={`backup-restore-off-${startKey(entry)}`}>
            <span className="backup-restore__name">{showExactly(entry.name)}</span>{" "}
            <span className="backup-restore__detail">
              {[startKind(entry), ...startLines(entry)].join(" · ")}
              {entry.onHere && " · on here now"}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
