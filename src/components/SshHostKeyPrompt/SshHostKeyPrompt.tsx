import { useEffect, useState, useCallback } from "react";
import { TrustPrompt, type TrustFact } from "@/components/ui";
import { onSshHostKeyPrompt, onSshHostKeyPromptClosed } from "@/services/events";
import { sshHostKeyDecision } from "@/services/api";
import type { SshHostKeyPromptPayload } from "@/types/sshHostKey";
import { useAppStore } from "@/store/appStore";
import { collectLiveTabs } from "@/store/layoutHelpers";
import { promptConnectionName } from "@/utils/promptOwner";
import { hostKeyChanges } from "@/utils/hostKeyChanges";

/**
 * Global interactive SSH host-key trust dialog (#1959) — the terminal analogue
 * of the RDP {@link RemoteDesktopCertPrompt}.
 *
 * The SSH handshake blocks when a server presents an untrusted host key and
 * emits `ssh-host-key-prompt`; this dialog surfaces the SHA-256 fingerprint and
 * lets the user accept it once, accept and remember it for the host, or reject.
 * When the key *changed* for a previously-trusted host (`changed`), it warns
 * prominently about a possible man-in-the-middle, shows the previously-trusted
 * key(s) above the newly presented one (each with its key type, when known) so
 * the user can compare exactly what changed (UX-034, #5627), and offers to
 * "Replace trusted key". The verdict is routed back to the blocked handshake
 * via `sshHostKeyDecision`.
 *
 * Any SSH connect path (terminal, tunnel, SFTP, jump host) can raise a prompt,
 * so this mounts once at the app root and serialises concurrent prompts through
 * a small queue — one dialog at a time.
 *
 * When the connect behind a prompt is aborted or times out, the backend sends
 * `ssh-host-key-prompt-closed` and the prompt is dropped from the queue — open
 * or still waiting — so nobody is asked to trust a key for a connect that no
 * longer exists (#5185).
 *
 * The prompt names its connect (`owner`); while it is open, that tab's
 * client-side connect deadline is paused, and it resumes once the prompt is
 * decided or closed (#5243). The owning tab also names the connection the
 * user clicked, shown above the host (#5862, R-111). A prompt with no owning
 * tab (tunnel, SFTP browser, agent, Test) shows the connection name the
 * backend connect put on the event instead (#5943).
 *
 * On a changed key the old and the new fingerprint are grouped in aligned
 * four-character pieces, each with a block glyph drawn from it, and the dialog
 * says in words what changed (#5862, R-109).
 */
export function SshHostKeyPrompt() {
  const [queue, setQueue] = useState<SshHostKeyPromptPayload[]>([]);
  const current = queue[0] ?? null;
  // The connection behind the prompt: the terminal tab that raised it first
  // (#5862), else the name the backend connect gave it — a tunnel, SFTP
  // browser, agent or Test has no tab (#5943). A string selector, so the
  // dialog only re-renders when it changes.
  const tabConnectionName = useAppStore((s) =>
    promptConnectionName(current?.owner, collectLiveTabs(s))
  );
  const connectionName = tabConnectionName ?? (current?.connection_name?.trim() || undefined);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    let active = true;
    const keep = (fn: () => void) => {
      if (active) unlisteners.push(fn);
      else fn();
    };
    void onSshHostKeyPrompt((payload) => {
      // The owning tab's connect deadline waits while the user decides (#5243).
      useAppStore.getState().pauseConnectDeadlineForPrompt(payload.prompt_id, payload.owner);
      setQueue((q) => [...q, payload]);
    }).then(keep);
    void onSshHostKeyPromptClosed(({ prompt_id }) => {
      useAppStore.getState().resumeConnectDeadlineForPrompt(prompt_id);
      setQueue((q) => q.filter((p) => p.prompt_id !== prompt_id));
    }).then(keep);
    return () => {
      active = false;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const decide = useCallback(
    (accept: boolean, remember: boolean) => {
      if (!current) return;
      // Decided: the connect's own deadline runs again (#5243).
      useAppStore.getState().resumeConnectDeadlineForPrompt(current.prompt_id);
      void sshHostKeyDecision(current.prompt_id, accept, remember);
      setQueue((q) => q.slice(1));
    },
    [current]
  );

  const changed = current?.changed ?? false;

  // On a changed key, the backend sends the key(s) trusted before — from
  // termiHub's own store and/or ~/.ssh/known_hosts — so the user can compare
  // old vs new (UX-034, #5627). Absent on first contact.
  const priorKeys = current?.previous_keys ?? [];
  const hasPrior = priorKeys.length > 0;
  const hostPort = current ? `${current.host}:${current.port}` : "";

  const facts: TrustFact[] = current
    ? [
        ...(connectionName
          ? [{ label: "Connection", value: connectionName, testId: "ssh-hostkey-connection" }]
          : []),
        { label: "Host", value: hostPort, testId: "ssh-hostkey-host" },
        // With a prior to compare against, each fingerprint carries its own key
        // type: the previously trusted key(s) first, then the presented one.
        ...(hasPrior
          ? []
          : [{ label: "Key type", value: current.key_type, testId: "ssh-hostkey-type" }]),
        ...priorKeys.map((key, i): TrustFact => {
          const testId = `ssh-hostkey-prev-fingerprint${i === 0 ? "" : `-${i}`}`;
          return {
            label: "Previously trusted",
            value: key.fingerprint,
            detail: key.key_type ?? undefined,
            detailTestId: `${testId}-type`,
            mono: true,
            copyable: true,
            copyNoun: "previously trusted fingerprint",
            glyph: true,
            glyphTestId: `${testId}-glyph`,
            testId,
            copyTestId: `${testId}-copy`,
          };
        }),
        {
          label: hasPrior ? "Now presented" : "Fingerprint",
          value: current.fingerprint,
          ...(hasPrior
            ? {
                detail: current.key_type,
                detailTestId: "ssh-hostkey-type",
                copyNoun: "new fingerprint",
                glyph: true,
                glyphTestId: "ssh-hostkey-fingerprint-glyph",
              }
            : {}),
          mono: true,
          copyable: true,
          testId: "ssh-hostkey-fingerprint",
          copyTestId: "ssh-hostkey-fingerprint-copy",
        },
      ]
    : [];

  return (
    <TrustPrompt
      open={current !== null}
      changed={changed}
      unknownTitle="Unknown host key"
      changedTitle="Host key changed"
      unknownLead="The SSH server presented a host key that is not yet trusted for:"
      changedLead="The SSH server presented a different host key than the one you trusted for:"
      changedWarningSubject="host key for this server"
      facts={facts}
      changes={current ? hostKeyChanges(current) : []}
      changesTestId="ssh-hostkey-changes"
      onReject={() => decide(false, false)}
      onAcceptOnce={() => decide(true, false)}
      onAcceptForHost={() => decide(true, true)}
      changedAcceptForHostLabel="Replace trusted key"
      changedHint={
        <>
          Verify the new fingerprint matches the one your server administrator reports.
          &ldquo;Replace trusted key&rdquo; replaces the old key for {hostPort}, so you are not
          asked again.
        </>
      }
      modalTestId="ssh-hostkey-prompt"
      rejectTestId="ssh-hostkey-reject"
      acceptOnceTestId="ssh-hostkey-accept-once"
      acceptForHostTestId="ssh-hostkey-accept-remember"
      warningTestId="ssh-hostkey-mitm-warning"
    />
  );
}
