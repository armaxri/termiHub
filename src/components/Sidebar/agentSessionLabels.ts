/** An agent session as the sidebar lists it: its id and its title. */
interface TitledSession {
  sessionId: string;
  title: string;
}

/**
 * The label each of an agent's sessions shows in "Active sessions" (#5953):
 * its title, with " 2", " 3", … added to the second and later sessions of the
 * same title, so two "agent · bash" rows can be told apart. The update strip
 * names the sessions with the same labels.
 */
export function agentSessionLabels(sessions: readonly TitledSession[]): Map<string, string> {
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const { sessionId, title } of sessions) {
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    labels.set(sessionId, n === 1 ? title : `${title} ${n}`);
  }
  return labels;
}
