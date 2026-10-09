/**
 * Pure routing for a terminal's keystrokes and shell-reported cwd.
 *
 * Extracted from the Terminal mount effect (#4350) so that the decision of
 * which keys reach the PTY, and how OSC 7 / OSC 9;9 working-directory reports
 * are parsed, is unit-testable outside the effect closure.
 */
import { COMMAND_MARK_ACTIONS } from "@/services/commandMarks";
import {
  isAppShortcut,
  isChordPending,
  isShellReservedKey,
  processKeyEvent,
} from "@/services/keybindings";

/** State and side effects the key router needs from its terminal. */
export interface TerminalKeyRoutingContext {
  /** Whether the tab currently has a live backend session. */
  hasSession: boolean;
  /** Whether the tab is in view mode (session ended, scrollback kept). */
  isViewMode: boolean;
  /** Settings → Keyboard Shortcuts → pass shell-reserved keys to the terminal. */
  passthroughEnabled: boolean;
  /** Whether the shell has emitted OSC 133 prompt marks. Only read when needed. */
  hasCommandMarks: () => boolean;
  /** Show the "reconnect?" prompt for a view-mode tab. */
  showReconnectPrompt: () => void;
  /** Copy the terminal selection to the clipboard. */
  copySelection: () => void;
  /** Paste the clipboard into the terminal. */
  paste: () => void;
  /** Select the whole terminal buffer. */
  selectAll: () => void;
}

/**
 * Decides whether a key event reaches the PTY. Returns `true` to let xterm
 * process the key, `false` to swallow it. Intended as the body of
 * `xterm.attachCustomKeyEventHandler`.
 *
 * The order of checks is load-bearing: shell-reserved passthrough runs before
 * shortcut matching so Ctrl-sequences the shell needs are never swallowed, and
 * paste calls `preventDefault` so the browser's native paste does not send the
 * clipboard a second time.
 */
export function routeTerminalKeyEvent(e: KeyboardEvent, ctx: TerminalKeyRoutingContext): boolean {
  if (e.type !== "keydown") return true;

  // In view mode the session is dead. Enter shows the reconnect prompt.
  if (e.key === "Enter" && !ctx.hasSession && ctx.isViewMode) {
    ctx.showReconnectPrompt();
    return false;
  }

  // Pass-through: keys reserved by the shell/tmux/vim/SSH-to-remote bypass
  // shortcut matching entirely so they reach the PTY untouched. Users can
  // turn this off in Settings → Keyboard Shortcuts.
  if (ctx.passthroughEnabled && isShellReservedKey(e)) {
    return true;
  }

  // If a chord is pending, block the key from xterm
  if (isChordPending()) {
    return false;
  }

  const action = processKeyEvent(e);
  if (action === "chord-pending") {
    return false;
  }
  if (action === "copy") {
    ctx.copySelection();
    return false;
  }
  if (action === "paste") {
    // Prevent the browser's default Cmd+V / Ctrl+Shift+V action so
    // that no native paste event fires on xterm's internal textarea.
    // Without this, the clipboard text is sent twice: once by our
    // pasteToTerminal() and once by xterm's internal paste handler.
    e.preventDefault();
    ctx.paste();
    return false;
  }
  if (action === "select-all") {
    ctx.selectAll();
    return false;
  }

  // Prompt-navigation / command-output shortcuts only mean something when
  // the shell emits OSC 133 marks. Without them, let the key reach the
  // shell exactly as before (#3415) — the global handler's run is a no-op.
  if (action && COMMAND_MARK_ACTIONS.has(action) && !ctx.hasCommandMarks()) {
    return true;
  }

  // Block any other app shortcut from reaching xterm
  if (isAppShortcut(e)) {
    return false;
  }

  return true;
}

/**
 * Parses an OSC 7 payload (POSIX shells: zsh, bash, WSL, SSH) into a cwd.
 *
 * The payload is a `file://` URI, e.g. `file:///home/user/foo` or
 * `file:///C:/foo`. Percent-escapes are decoded and a Windows drive path
 * (`/C:/foo`, e.g. from WSL forwarding) loses its leading slash. Returns
 * `null` for malformed input or a non-`file:` URI. The payload comes from the
 * remote host, so anything unexpected is ignored rather than thrown.
 */
export function parseOsc7Cwd(data: string): string | null {
  try {
    const url = new URL(data);
    if (url.protocol !== "file:") return null;
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname;
  } catch {
    return null;
  }
}

/**
 * Parses an OSC 9 payload into a cwd when it is the Windows Terminal
 * `9;<path>` form (PowerShell, cmd.exe), e.g. `9;C:\Users\foo`. The path is
 * used verbatim — no URL decoding or slash conversion. Returns `null` for any
 * other OSC 9 sub-command or an empty path.
 */
export function parseOsc9Cwd(data: string): string | null {
  if (!data.startsWith("9;")) return null;
  const path = data.slice(2);
  return path ? path : null;
}
