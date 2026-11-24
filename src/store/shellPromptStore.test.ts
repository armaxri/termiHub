import { describe, it, expect, beforeEach } from "vitest";
import {
  clearAwaitingFirstPrompt,
  expectsShellIntegrationMarks,
  markAwaitingFirstPrompt,
  useShellPromptStore,
} from "./shellPromptStore";

const state = () => useShellPromptStore.getState().awaitingFirstPrompt;

describe("shellPromptStore (#5891)", () => {
  beforeEach(() => useShellPromptStore.setState({ awaitingFirstPrompt: {} }));

  it("marks and clears a tab's first-prompt wait", () => {
    markAwaitingFirstPrompt("a");
    markAwaitingFirstPrompt("b");
    expect(state()).toEqual({ a: true, b: true });
    clearAwaitingFirstPrompt("a");
    expect(state()).toEqual({ b: true });
  });

  it("keeps the same state object for no-op updates", () => {
    markAwaitingFirstPrompt("a");
    const before = state();
    markAwaitingFirstPrompt("a");
    clearAwaitingFirstPrompt("missing");
    expect(state()).toBe(before);
  });

  it("expects marks only when the connection turns shell integration on", () => {
    expect(expectsShellIntegrationMarks({ config: { shellIntegration: true } })).toBe(true);
    expect(expectsShellIntegrationMarks({ config: { shellIntegration: false } })).toBe(false);
    expect(expectsShellIntegrationMarks({ config: {} })).toBe(false);
  });
});
