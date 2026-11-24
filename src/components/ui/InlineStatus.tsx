import { CheckCircle2, Info } from "lucide-react";

/** Props for {@link InlineStatus}. */
export interface InlineStatusProps {
  /** `success` for a confirmed result, `info` for a neutral note. */
  kind: "success" | "info";
  /** The status text; `null` renders an empty (still announced) live region. */
  message: string | null;
  /** Optional quieter second part of the line. */
  detail?: string;
  /** `data-testid` for the line. */
  testId?: string;
}

/**
 * The result of an action, shown where the action was taken (#5859): the
 * design-system rule is "feedback is visible in place; toast only when it
 * isn't". Use it beside the button whose result has no other on-screen state
 * (a connection test in an editor tab). A polite live region, so a screen
 * reader announces it the way it would a toast. Same look as a dialog's inline
 * status line (#5830).
 */
export function InlineStatus({ kind, message, detail, testId }: InlineStatusProps) {
  const Icon = kind === "success" ? CheckCircle2 : Info;
  return (
    <div
      className="ui-inline-status"
      role="status"
      aria-live="polite"
      data-kind={kind}
      data-testid={testId}
    >
      {message ? (
        <>
          <Icon className="ui-inline-status__icon" aria-hidden="true" />
          <span className="ui-inline-status__text">
            {message}
            {detail ? <span className="ui-inline-status__detail"> {detail}</span> : null}
          </span>
        </>
      ) : null}
    </div>
  );
}
