import { useCallback, useState } from "react";
import { getSshAlgorithms } from "@/services/api";
import { fireAndForget } from "@/utils/frontendLog";
import type { SshNegotiatedAlgorithms } from "@/types/generated/SshNegotiatedAlgorithms";

/** The algorithms one session reported, kept with its id. */
interface Known {
  sessionId: string;
  algorithms: SshNegotiatedAlgorithms;
}

/** What {@link useSshAlgorithms} returns. */
export interface SshAlgorithmsState {
  /** The session's negotiated algorithms, `null` until it reported them. */
  algorithms: SshNegotiatedAlgorithms | null;
  /** Ask the backend; call when the popover opens. A no-op once known. */
  request: () => void;
}

/**
 * The algorithms an SSH session negotiated (#5896), asked of the backend on
 * demand — when the status bar's security popover opens — instead of on every
 * render. An answer of `null` (non-SSH session, older agent) or a failed ask
 * leaves `algorithms` `null`, so the popover keeps its "Encrypted (SSH)" row
 * and asks again the next time it opens.
 */
export function useSshAlgorithms(sessionId: string | null | undefined): SshAlgorithmsState {
  const [known, setKnown] = useState<Known | null>(null);
  const algorithms = known && known.sessionId === sessionId ? known.algorithms : null;

  const request = useCallback(() => {
    if (!sessionId || algorithms) return;
    // A failed ask (unknown session, backend error) keeps the fallback row.
    fireAndForget(
      getSshAlgorithms(sessionId).then((answer) => {
        if (answer) setKnown({ sessionId, algorithms: answer });
      }),
      "ask the SSH session's negotiated algorithms"
    );
  }, [sessionId, algorithms]);

  return { algorithms, request };
}
