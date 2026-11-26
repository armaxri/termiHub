import { ConfirmDialog } from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import { useAppStore } from "@/store/appStore";
import { joinWords } from "@/utils/joinWords";

/**
 * Asks before a run stops the one that is in progress (#6042): it would end between
 * two of its steps, and nothing said so.
 */
export function RunReplaceDialog() {
  const prompt = useAppStore((s) => s.runReplacePrompt);
  const resolve = useAppStore((s) => s.resolveRunReplacePrompt);
  const running = prompt?.running ?? [];
  const names = joinWords(
    running.map((r) =>
      tf("automation.replace.one", { name: r.name, where: r.where, progress: r.progress })
    )
  );
  return (
    <ConfirmDialog
      open={prompt !== null}
      variant="warn"
      title={tf("automation.replace.title", { name: prompt?.name ?? "" })}
      message={tf("automation.replace.message", { running: names })}
      confirmLabel={t("automation.replace.accept")}
      confirmOnEnter={false}
      onConfirm={() => resolve(true)}
      onCancel={() => resolve(false)}
      testIdBase="run-replace"
      data-testid="run-replace-dialog"
    />
  );
}
