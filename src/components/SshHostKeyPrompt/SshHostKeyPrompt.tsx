import { useEffect, useState, useCallback } from "react";
import { TrustPrompt, type TrustFact } from "@/components/ui";
import { onSshHostKeyPrompt } from "@/services/events";
import { sshHostKeyDecision } from "@/services/api";
import type { SshHostKeyPromptPayload } from "@/types/sshHostKey";

/**
 * Global interactive SSH host-key trust dialog (#1959) — the terminal analogue
 * of the RDP {@link RemoteDesktopCertPrompt}.
 *
 * The SSH handshake blocks when a server presents an untrusted host key and
 * emits `ssh-host-key-prompt`; this dialog surfaces the SHA-256 fingerprint and
 * lets the user accept it once, accept and remember it for the host, or reject.
 * When the key *changed* for a previously-trusted host (`changed`), it warns
 * prominently about a possible man-in-the-middle and, when the backend supplies
 * the previously-trusted fingerprint(s), shows them beside the new one so the
 * user can compare exactly what changed (UX-034). The verdict is routed back to
 * the blocked handshake via `sshHostKeyDecision`.
 *
 * Any SSH connect path (terminal, tunnel, SFTP, jump host) can raise a prompt,
 * so this mounts once at the app root and serialises concurrent prompts through
 * a small queue — one dialog at a time.
 */
export function SshHostKeyPrompt() {
  const [queue, setQueue] = useState<SshHostKeyPromptPayload[]>([]);
  const current = queue[0] ?? null;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void onSshHostKeyPrompt((payload) => {
      setQueue((q) => [...q, payload]);
    }).then((fn) => {
      if (active) {
        unlisten = fn;
      } else {
        fn();
      }
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const decide = useCallback(
    (accept: boolean, remember: boolean) => {
      if (!current) return;
      void sshHostKeyDecision(current.prompt_id, accept, remember);
      setQueue((q) => q.slice(1));
    },
    [current]
  );

  const changed = current?.changed ?? false;

  // On a changed key, the backend sends the fingerprint(s) termiHub had trusted
  // so the user can compare old vs new (UX-034). Absent/empty on first contact
  // (and when the change was only against the user's ~/.ssh/known_hosts).
  const priorFingerprints = current?.previous_fingerprints ?? [];
  const hasPrior = priorFingerprints.length > 0;

  const facts: TrustFact[] = current
    ? [
        { label: "Host", value: `${current.host}:${current.port}`, testId: "ssh-hostkey-host" },
        { label: "Key type", value: current.key_type, testId: "ssh-hostkey-type" },
        // When a prior fingerprint exists, show it beside the new one, each
        // clearly labeled and copyable, so the user can see exactly what changed.
        ...priorFingerprints.map(
          (fp, i): TrustFact => ({
            label: "Previously trusted",
            value: fp,
            mono: true,
            copyable: true,
            testId: `ssh-hostkey-prev-fingerprint${i === 0 ? "" : `-${i}`}`,
            copyTestId: `ssh-hostkey-prev-fingerprint${i === 0 ? "" : `-${i}`}-copy`,
          })
        ),
        {
          label: hasPrior ? "New" : "Fingerprint",
          value: current.fingerprint,
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
      onReject={() => decide(false, false)}
      onAcceptOnce={() => decide(true, false)}
      onAcceptForHost={() => decide(true, true)}
      modalTestId="ssh-hostkey-prompt"
      rejectTestId="ssh-hostkey-reject"
      acceptOnceTestId="ssh-hostkey-accept-once"
      acceptForHostTestId="ssh-hostkey-accept-remember"
      warningTestId="ssh-hostkey-mitm-warning"
    />
  );
}
