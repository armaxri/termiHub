import { macroPreviewLines } from "@/components/AutomationEditor/keysFormat";
import { recordedParts, type Recorded } from "@/services/inputRecorder";

/**
 * The lines a recording types, with a mark where something was typed at a
 * password prompt (#6025). That itself is never shown.
 */
export function recordingPreview(
  take: Pick<Recorded, "chunks" | "secrets">,
  keepSecrets: boolean
): string[] {
  const mark = keepSecrets ? "[password, stored]" : "[password left out]";
  const lines: string[] = [];
  for (const part of recordedParts(take)) {
    if (part.kind === "keys") lines.push(...macroPreviewLines(part.chunks));
    else if (lines.length === 0) lines.push(mark);
    else lines[lines.length - 1] += `⏎  ${mark}`;
  }
  return lines;
}
