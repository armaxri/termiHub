/**
 * Payloads of the SSH keyboard-interactive prompt events (#3371).
 *
 * `ssh-keyboard-interactive-prompt` asks the user to answer one OTP / 2FA / PAM
 * round; the dialog replies through `sshKeyboardInteractiveRespond` with one
 * response per prompt (or `null` to cancel).
 * `ssh-keyboard-interactive-prompt-closed` tells the dialog a prompt is no
 * longer awaited (the connect was cancelled or timed out).
 *
 * Generated from the Rust event types via ts-rs; fields are snake_case to match
 * the Rust serialization.
 */
export type { SshKeyboardInteractivePromptEvent as SshKeyboardInteractivePromptPayload } from "./generated/SshKeyboardInteractivePromptEvent";
export type { SshKeyboardInteractivePromptClosedEvent as SshKeyboardInteractivePromptClosedPayload } from "./generated/SshKeyboardInteractivePromptClosedEvent";
export type { SshKeyboardInteractivePromptItem } from "./generated/SshKeyboardInteractivePromptItem";
