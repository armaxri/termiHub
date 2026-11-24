import { create } from "zustand";

interface ShellPromptStore {
  /**
   * Terminal tabs whose shell integration is on but whose shell has not yet
   * sent its first OSC 133 command mark, keyed by tab id (#5891).
   */
  awaitingFirstPrompt: Record<string, boolean>;
}

/**
 * Which terminal tabs still wait for the shell's first prompt (#5891).
 *
 * A tab with shell integration on gets OSC 133 marks once its shell reaches a
 * prompt. Until the first mark arrives the shell may still be starting, or be
 * blocked on a startup question (an `oh-my-zsh` update prompt, a `.zshrc`
 * `read`), so the tab's status dot stays neutral instead of showing
 * "connected". Tabs without shell integration are never added: no mark will
 * ever arrive, so they keep the plain connected dot.
 *
 * Runtime-only and outside the app store: a pure display feed derived from this
 * window's xterm parser.
 */
export const useShellPromptStore = create<ShellPromptStore>(() => ({
  awaitingFirstPrompt: {},
}));

/** Start waiting for `tabId`'s first prompt mark. */
export function markAwaitingFirstPrompt(tabId: string): void {
  useShellPromptStore.setState((s) =>
    s.awaitingFirstPrompt[tabId]
      ? s
      : { awaitingFirstPrompt: { ...s.awaitingFirstPrompt, [tabId]: true } }
  );
}

/** Stop waiting for `tabId`'s first prompt: a mark arrived, or the terminal went away. */
export function clearAwaitingFirstPrompt(tabId: string): void {
  useShellPromptStore.setState((s) => {
    if (!(tabId in s.awaitingFirstPrompt)) return s;
    const { [tabId]: _dropped, ...rest } = s.awaitingFirstPrompt;
    return { awaitingFirstPrompt: rest };
  });
}

/** The tabs still waiting for their shell's first prompt. */
export function useAwaitingFirstPromptTabs(): Record<string, boolean> {
  return useShellPromptStore((s) => s.awaitingFirstPrompt);
}

/**
 * Whether a tab's connection turns shell integration on (and so whether OSC 133
 * marks are expected). Reads the connection's `shellIntegration` setting.
 */
export function expectsShellIntegrationMarks(config: { config: Record<string, unknown> }): boolean {
  return config.config.shellIntegration === true;
}
