import { AlertTriangle } from "lucide-react";
import { Modal, Button } from "@/components/ui";
import { t } from "@/i18n/catalog";
import { useAppStore } from "@/store/appStore";
import "./LocalProcessAuthDialog.css";

/**
 * Confirmation dialog gating a guarded `run-local-process` workflow step (#1857).
 *
 * Shown when a running workflow reaches a local-process step whose program is not
 * yet on the allowlist (and the master opt-in is already enabled). It spells out
 * exactly what would run — program + each discrete argument — because this step
 * executes a program on the user's own machine, unlike every other workflow step.
 *
 * Three outcomes, mirroring the store's {@link LocalProcessAuthDecision}:
 * - **Don't allow** — refuse; the step fails (the safe default, focused).
 * - **Allow once** — run this time only; nothing is remembered.
 * - **Always allow** — run and remember the program on the allowlist.
 *
 * Mounted globally so it works no matter how the workflow was launched (sidebar,
 * palette, hotkey).
 */
export function LocalProcessAuthDialog() {
  const prompt = useAppStore((s) => s.localProcessPrompt);
  const resolve = useAppStore((s) => s.resolveLocalProcessPrompt);

  const open = prompt !== null;

  return (
    <Modal
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resolve("cancel");
      }}
      title="Run a local program?"
      data-testid="local-process-auth-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => resolve("cancel")}
            data-testid="local-process-auth-cancel"
          >
            Don&apos;t allow
          </Button>
          <Button
            variant="secondary"
            onClick={() => resolve("once")}
            data-testid="local-process-auth-once"
          >
            Allow once
          </Button>
          <Button
            variant="ghost"
            onClick={() => resolve("always")}
            data-testid="local-process-auth-always"
          >
            Always allow
          </Button>
        </>
      }
    >
      {prompt && (
        <div className="local-process-auth">
          <p className="local-process-auth__lead">
            <AlertTriangle size={16} className="local-process-auth__icon" />
            <span>
              The automation <strong>{prompt.workflowName}</strong> wants to run a program on this
              computer. Only allow it if you trust this automation.
            </span>
          </p>
          <div className="local-process-auth__field">
            <span className="local-process-auth__label">Program</span>
            <code className="local-process-auth__value" data-testid="local-process-auth-program">
              {prompt.program || "(none)"}
            </code>
          </div>
          {prompt.path !== prompt.program && (
            <div className="local-process-auth__field">
              <span className="local-process-auth__label">File</span>
              <code className="local-process-auth__value" data-testid="local-process-auth-path">
                {prompt.path}
              </code>
            </div>
          )}
          <div className="local-process-auth__field">
            <span className="local-process-auth__label">
              {prompt.args.length === 1 ? "Argument" : "Arguments"}
            </span>
            {prompt.args.length === 0 ? (
              <span className="local-process-auth__none">none</span>
            ) : (
              <ol className="local-process-auth__args" data-testid="local-process-auth-args">
                {prompt.args.map((arg, i) => (
                  <li key={i}>
                    <code>{arg}</code>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <p className="local-process-auth__note">
            &ldquo;Always allow&rdquo; remembers this file, with any arguments and for every
            automation; manage or revoke it later under Settings &rarr; Security.
          </p>
          <p className="local-process-auth__refuse" data-testid="local-process-auth-refuse">
            {t(prompt.goesOn ? "automation.program.goesOn" : "automation.program.stops")}
          </p>
        </div>
      )}
    </Modal>
  );
}
