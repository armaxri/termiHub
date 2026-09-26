import { useCallback, useEffect, useState } from "react";
import { Button, Field, Input, Modal } from "@/components/ui";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import {
  onSshKeyboardInteractivePrompt,
  onSshKeyboardInteractivePromptClosed,
} from "@/services/events";
import { sshKeyboardInteractiveRespond } from "@/services/api";
import type { SshKeyboardInteractivePromptPayload } from "@/types/sshKeyboardInteractive";
import "./SshKeyboardInteractivePrompt.css";

/** Server prompts usually end in ": " — drop that for the field label. */
function promptLabel(prompt: string, index: number): string {
  const trimmed = prompt.trim().replace(/:\s*$/, "");
  return trimmed || `Response ${index + 1}`;
}

/**
 * Global SSH keyboard-interactive dialog (#3371, PARITY-010): answers OTP / 2FA
 * / PAM challenge prompts sent by an SSH server during authentication.
 *
 * The SSH auth exchange emits `ssh-keyboard-interactive-prompt` with the
 * server's name, instruction text and N prompts (each with an echo flag); this
 * dialog renders one field per prompt — masked when echo is off — and replies
 * with the answers (or `null` on Cancel) via `sshKeyboardInteractiveRespond`.
 * A prompt the backend stops awaiting (connect cancelled / timed out) arrives
 * as `ssh-keyboard-interactive-prompt-closed` and is dropped.
 *
 * Any SSH connect path (terminal, tunnel, SFTP, jump host, Test Connection)
 * can raise a prompt, so this mounts once at the app root and shows queued
 * prompts one at a time. Prompts of SSH connections a remote agent
 * authenticates (#3375) arrive the same way, with `via` naming the agent.
 */
export function SshKeyboardInteractivePrompt() {
  const [queue, setQueue] = useState<SshKeyboardInteractivePromptPayload[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const current = queue[0] ?? null;
  const currentId = current?.prompt_id ?? null;
  const promptCount = current?.prompts.length ?? 0;

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];
    const keep = (fn: () => void) => {
      if (active) unlisteners.push(fn);
      else fn();
    };
    void onSshKeyboardInteractivePrompt((payload) => {
      setQueue((q) => [...q, payload]);
    }).then(keep);
    void onSshKeyboardInteractivePromptClosed(({ prompt_id }) => {
      setQueue((q) => q.filter((p) => p.prompt_id !== prompt_id));
    }).then(keep);
    return () => {
      active = false;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Fresh, empty answers for every new prompt — never carry a secret over.
  useEffect(() => {
    setAnswers(Array.from({ length: promptCount }, () => ""));
  }, [currentId, promptCount]);

  const reply = useCallback(
    (responses: string[] | null) => {
      if (!current) return;
      void sshKeyboardInteractiveRespond(current.prompt_id, responses);
      setAnswers([]);
      setQueue((q) => q.filter((p) => p.prompt_id !== current.prompt_id));
    },
    [current]
  );

  const handleSubmit = useCallback(() => reply(answers), [answers, reply]);
  const handleCancel = useCallback(() => reply(null), [reply]);

  const setAnswer = useCallback((index: number, value: string) => {
    setAnswers((prev) => prev.map((a, i) => (i === index ? value : a)));
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSubmit();
    },
    [handleSubmit]
  );

  return (
    <Modal
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) handleCancel();
      }}
      title="SSH Authentication"
      footer={
        <>
          <Button variant="secondary" onClick={handleCancel} data-testid="kbd-interactive-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} data-testid="kbd-interactive-submit">
            Continue
          </Button>
        </>
      }
    >
      {current && (
        <>
          <p className="kbd-interactive-prompt__target" data-testid="kbd-interactive-target">
            {current.name && (
              <span className="kbd-interactive-prompt__name" data-testid="kbd-interactive-name">
                {current.name}
                {" — "}
              </span>
            )}
            {`${current.username}@${current.host}:${current.port}`}
            {current.via && (
              <span className="kbd-interactive-prompt__via" data-testid="kbd-interactive-via">
                {` via agent ${current.via}`}
              </span>
            )}
          </p>
          {current.instructions && (
            <p
              className="kbd-interactive-prompt__instructions"
              data-testid="kbd-interactive-instructions"
            >
              {current.instructions}
            </p>
          )}
          <div className="kbd-interactive-prompt__fields">
            {current.prompts.map((p, i) => {
              const label = promptLabel(p.prompt, i);
              const common = {
                value: answers[i] ?? "",
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAnswer(i, e.target.value),
                onKeyDown: handleKeyDown,
                autoFocus: i === 0,
                "aria-label": label,
                "data-testid": `kbd-interactive-input-${i}`,
              };
              return (
                <Field key={`${current.prompt_id}-${i}`} label={label}>
                  {p.echo ? (
                    <Input {...common} autoComplete="off" />
                  ) : (
                    <PasswordInput {...common} className="ui-input" />
                  )}
                </Field>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
