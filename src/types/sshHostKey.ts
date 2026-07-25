/**
 * Payload of the `ssh-host-key-prompt` event (#1959): an SSH server presented an
 * untrusted (unknown or changed) host key that needs an interactive trust
 * decision.
 *
 * Fields are snake_case to match the Rust event serialization. `prompt_id`
 * correlates the user's reply (`sshHostKeyDecision`) back to the blocked SSH
 * handshake; `changed` is `true` for the possible-MITM case (a different key for
 * a previously-trusted host) that the dialog warns about prominently.
 */
export interface SshHostKeyPromptPayload {
  prompt_id: string;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  changed: boolean;
}
