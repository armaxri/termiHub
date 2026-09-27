import { useEffect } from "react";
import { toast } from "@/components/ui";
import { folderPasteTakeInterrupted, type InterruptedFolderPaste } from "@/services/api";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import {
  endpointLabel,
  folderName,
  FolderPasteEndpointUnavailable,
  retryInterruptedFolderPaste,
} from "./sessionFolderPaste";

/** The notice text for an interrupted paste. */
export function interruptedPasteMessage(paste: InterruptedFolderPaste): {
  title: string;
  description: string;
} {
  const verb = paste.operation === "cut" ? "Moving" : "Pasting";
  return {
    title: `${verb} “${folderName(paste.source.path)}” did not finish`,
    description:
      `Some files may not have been copied to ${endpointLabel(paste.destination)}` +
      ` (${paste.destination.path}). Retry copies only the missing files.`,
  };
}

/** Show the persistent notice for one interrupted paste, with a Retry action. */
export function showInterruptedPasteNotice(paste: InterruptedFolderPaste): void {
  const { title, description } = interruptedPasteMessage(paste);
  toast.error(title, {
    id: `folder-paste-${paste.id}`,
    description,
    action: { label: "Retry", onClick: () => void retryFromNotice(paste) },
  });
}

/**
 * Continue an interrupted paste from its notice: a loading toast that resolves
 * into success, or back into the notice (with its Retry) on failure — so a
 * half-copied folder is never reported as complete.
 */
export async function retryFromNotice(paste: InterruptedFolderPaste): Promise<void> {
  const name = folderName(paste.source.path);
  const toastId = toast.loading(`Finishing “${name}”…`);
  try {
    await retryInterruptedFolderPaste(paste);
    toast.success(`Finished pasting “${name}”`, { id: toastId });
  } catch (err) {
    toast.dismiss(toastId);
    const reason =
      err instanceof FolderPasteEndpointUnavailable
        ? err.message
        : `Retry failed: ${errorMessage(err)}`;
    frontendLog("folder_paste", `Retry of ${paste.source.path} failed: ${errorMessage(err)}`);
    const { title } = interruptedPasteMessage(paste);
    toast.error(title, {
      id: `folder-paste-${paste.id}`,
      description: reason,
      action: { label: "Retry", onClick: () => void retryFromNotice(paste) },
    });
  }
}

/**
 * On startup, tell the user about every folder paste a previous run left
 * unfinished (#3630) — a quit, crash or failure part-way through a
 * cross-session folder paste — and offer a Retry that copies the rest.
 * Each interrupted paste is reported once (the backend hands it out once).
 */
export function useInterruptedFolderPastes(): void {
  useEffect(() => {
    // No cancellation guard: the backend hands each paste out once, so a
    // re-run effect (StrictMode) must still show what the first run took.
    folderPasteTakeInterrupted()
      .then((pastes) => pastes.forEach(showInterruptedPasteNotice))
      .catch((err) =>
        frontendLog("folder_paste", `Could not load interrupted pastes: ${errorMessage(err)}`)
      );
  }, []);
}
