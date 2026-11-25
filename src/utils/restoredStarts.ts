/**
 * What a restore leaves switched off (#6056): the pure helpers of the preview, the
 * list after the restart and the one action that turns entries on.
 */
import type { SectionChoice } from "@/components/Settings/BackupSectionRow";
import type { RestoredStart } from "@/types/backup";
import { formatDayTime } from "@/utils/formatters";
import { showExactly } from "@/utils/showExactly";

const KINDS: Record<string, string> = {
  schedules: "Schedule",
  automations: "Automation",
  workflows: "Automation",
  tunnels: "Tunnel",
  embeddedServers: "File server",
};

/** "Schedule", "Tunnel": what kind of entry it is. */
export function startKind(entry: Pick<RestoredStart, "section">): string {
  return KINDS[entry.section] ?? "Entry";
}

/** The key of an entry. */
export function startKey(entry: Pick<RestoredStart, "section" | "id">): string {
  return `${entry.section}-${entry.id}`;
}

/** What would start it, with the next run: "Daily at 02:00 on Build Box · next Fri 02:00". */
export function startLines(entry: RestoredStart, now: Date = new Date()): string[] {
  const next = entry.nextRunAt ? new Date(entry.nextRunAt) : null;
  return entry.starts.map((line, i) => {
    const text = showExactly(line);
    // A list kept since an earlier day names no run that is over.
    return i === 0 && next && next > now ? `${text} · next ${formatDayTime(next, now)}` : text;
  });
}

/**
 * Which previewed entries the chosen parts would leave switched off. An entry that is
 * here stays as it is while the backup only adds to its section ("Keep mine").
 */
export function startsOfChoice(
  entries: readonly RestoredStart[],
  choices: Record<string, SectionChoice>
): RestoredStart[] {
  const overwrites = (choice: SectionChoice | undefined) =>
    !!choice?.include && (choice.mode === "replace" || choice.conflicts === "overwrite");
  const anyOverwrites = Object.values(choices).some(overwrites);
  return entries.filter((entry) => {
    const choice = choices[entry.section];
    if (!entry.existsHere) return choice?.include ?? false;
    // The entry itself is the same: something it uses is overwritten.
    if (entry.onHere && entry.sameHere) return anyOverwrites;
    return overwrites(choice);
  });
}
