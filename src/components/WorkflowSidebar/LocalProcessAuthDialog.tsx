import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal, Button } from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import { joinWords } from "@/utils/joinWords";
import { showExactly } from "@/utils/showExactly";
import { useAppStore } from "@/store/appStore";
import type { LocalProcessPromptState } from "@/store/slices/workflowsSlice";
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./LocalProcessAuthDialog.css";

/** Why the user is asked, above the command. */
function lead({ workflowName, imported }: LocalProcessPromptState): string {
  if (imported.length === 0) return "";
  if (imported.length === 1 && imported[0] === workflowName) {
    return tf("localProcess.imported.lead", { name: workflowName });
  }
  return tf(
    imported.length === 1 ? "localProcess.imported.leadOther" : "localProcess.imported.leadOthers",
    { name: workflowName, imported: joinWords(imported.map((name) => `“${name}”`)) }
  );
}

/** What "always" remembers. */
function note({ remember }: LocalProcessPromptState): string {
  switch (remember) {
    case "program":
      return t("localProcess.note.program");
    case "command":
      return t("localProcess.note.command");
    case "nothing":
      return t("localProcess.note.nothing");
  }
}

/**
 * Confirmation dialog gating a guarded `run-local-process` workflow step (#1857).
 *
 * Shown when a running workflow reaches a local-process step whose program is not
 * yet on the allowlist (and the master opt-in is already enabled), and before every
 * command of an imported automation that was not confirmed (#6019). It spells out
 * exactly what would run — program + each discrete argument — because this step
 * executes a program on the user's own machine, unlike every other workflow step.
 *
 * Three outcomes, mirroring the store's {@link LocalProcessAuthDecision}:
 * - **Don't allow** — refuse; the step fails (the safe default, focused).
 * - **Allow once** — run this time only; nothing is remembered.
 * - **Always allow** — run and remember the program on the allowlist. For a program
 *   that runs whatever it is told to, this says so and asks again. For an imported
 *   automation, only this very command is remembered.
 *
 * Mounted globally so it works no matter how the workflow was launched (sidebar,
 * palette, hotkey).
 */
export function LocalProcessAuthDialog() {
  const prompt = useAppStore((s) => s.localProcessPrompt);
  const resolve = useAppStore((s) => s.resolveLocalProcessPrompt);
  // The prompt whose "Always allow" was chosen for an interpreter; another prompt
  // starts over.
  const [warnedFor, setWarnedFor] = useState<LocalProcessPromptState | null>(null);

  const open = prompt !== null;
  const warned = prompt !== null && warnedFor === prompt;
  const imported = prompt !== null && prompt.imported.length > 0;

  const handleAlways = () => {
    if (prompt?.interpreter && prompt.remember === "program") setWarnedFor(prompt);
    else resolve("always");
  };

  return (
    <Modal
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resolve("cancel");
      }}
      title={t(imported ? "localProcess.imported.title" : "localProcess.title")}
      data-testid="local-process-auth-dialog"
      footer={
        warned ? (
          <>
            <Button
              variant="secondary"
              onClick={() => setWarnedFor(null)}
              data-testid="local-process-auth-back"
            >
              {t("localProcess.back")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => resolve("once")}
              data-testid="local-process-auth-once"
            >
              {t("localProcess.once")}
            </Button>
            <Button
              variant="danger"
              onClick={() => resolve("always")}
              data-testid="local-process-auth-always-anyway"
            >
              {t("localProcess.alwaysAnyway")}
            </Button>
          </>
        ) : (
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
              {t("localProcess.once")}
            </Button>
            {prompt?.remember !== "nothing" && (
              <Button
                variant="ghost"
                onClick={handleAlways}
                data-testid="local-process-auth-always"
              >
                {t(
                  prompt?.remember === "command"
                    ? "localProcess.alwaysCommand"
                    : "localProcess.always"
                )}
              </Button>
            )}
          </>
        )
      }
    >
      {prompt && (
        <div className="local-process-auth">
          <p className="local-process-auth__lead" data-testid="local-process-auth-lead">
            <AlertTriangle size={ICON_SIZE.md} className="local-process-auth__icon" />
            {imported ? (
              <span>{lead(prompt)}</span>
            ) : (
              <span>
                The automation <strong>{prompt.workflowName}</strong> wants to run a program on this
                computer. Only allow it if you trust this automation.
              </span>
            )}
          </p>
          {warned ? (
            <div
              className="local-process-auth__warning"
              role="alert"
              data-testid="local-process-auth-interpreter"
            >
              <strong>{tf("localProcess.interpreter.title", { program: prompt.program })}</strong>
              <span>{tf("localProcess.interpreter.text", { path: prompt.path })}</span>
            </div>
          ) : null}
          {prompt.terminals?.length ? (
            <div className="local-process-auth__field" data-testid="local-process-auth-terminals">
              <span className="local-process-auth__label">
                {t(
                  prompt.terminals.length === 1 ? "localProcess.terminal" : "localProcess.terminals"
                )}
              </span>
              <span className="local-process-auth__value">
                {prompt.terminals.length === 1
                  ? prompt.terminals[0]
                  : tf("localProcess.terminalsShared", { terminals: prompt.terminals.join(", ") })}
              </span>
            </div>
          ) : null}
          <div className="local-process-auth__field">
            <span className="local-process-auth__label">Program</span>
            <code className="local-process-auth__value" data-testid="local-process-auth-program">
              {showExactly(prompt.program) || "(none)"}
            </code>
          </div>
          {prompt.path !== prompt.program && (
            <div className="local-process-auth__field">
              <span className="local-process-auth__label">File</span>
              <code className="local-process-auth__value" data-testid="local-process-auth-path">
                {showExactly(prompt.path)}
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
                    {arg === "" ? (
                      <span className="local-process-auth__none">{t("localProcess.emptyArg")}</span>
                    ) : (
                      <code>{showExactly(arg)}</code>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <p className="local-process-auth__note" data-testid="local-process-auth-note">
            {note(prompt)}
          </p>
          <p className="local-process-auth__refuse" data-testid="local-process-auth-refuse">
            {t(prompt.goesOn ? "automation.program.goesOn" : "automation.program.stops")}
          </p>
        </div>
      )}
    </Modal>
  );
}
